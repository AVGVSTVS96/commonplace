import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

import { $ } from "bun";

import { event, iso, link, thing } from "../src/schema.ts";
import type { Row } from "../src/schema.ts";
import { defineSource, json, jsonl, writeJsonl } from "../src/source.ts";

interface Issue {
  readonly repository: { readonly nameWithOwner: string };
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly isDraft?: boolean;
  readonly createdAt: string;
  readonly closedAt?: string;
  readonly url: string;
}

interface Reviewed {
  readonly repository_url: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly user: { readonly login: string };
  readonly state: string;
  readonly draft: boolean;
  readonly created_at: string;
  readonly closed_at: string | null;
  readonly pull_request: { readonly merged_at: string | null };
}

interface Review {
  readonly id: number;
  readonly repo: string;
  readonly pr: number;
  readonly state: string;
  readonly body: string;
  readonly html_url: string;
  readonly commit_id: string | null;
  readonly submitted_at?: string;
}

interface ReviewComment {
  readonly id: number;
  readonly pull_request_review_id: number;
  readonly in_reply_to_id?: number;
  readonly body: string;
  readonly path: string;
  readonly line: number | null;
  readonly html_url: string;
  readonly created_at: string;
}

interface Commit {
  readonly sha: string;
  readonly date: string;
  readonly author: string;
  readonly email: string;
  readonly subject: string;
  readonly body: string;
  readonly repo: string;
  readonly remote: string;
  readonly path: string;
}

interface Star {
  readonly starred_at: string;
  readonly repo: {
    readonly full_name: string;
    readonly description: string | null;
    readonly html_url: string;
    readonly language: string | null;
    readonly topics: readonly string[];
    readonly created_at: string;
  };
}

export interface GitHubOptions {
  readonly clones?: readonly string[];
  readonly authors?: readonly string[];
}

const fields = {
  prs: "repository,number,title,body,state,isDraft,createdAt,closedAt,url",
  issues: "repository,number,title,body,state,createdAt,closedAt,url",
};

const day = (date: Date) => date.toISOString().slice(0, 10);

const trimmed = async (command: $.ShellPromise): Promise<string> => {
  const output = await command.text();

  return output.trim();
};

const search = async (command: () => Promise<$.ShellOutput>): Promise<string> => {
  for (let tries = 1; ; tries += 1) {
    const result = await command();

    if (result.exitCode === 0) {
      return result.stdout.toString();
    }

    if (tries === 5 || !result.stderr.toString().includes("rate limit")) {
      throw new Error(result.stderr.toString().trim());
    }

    await Bun.sleep(61_000);
  }
};

const searchAll = async (
  kind: "prs" | "issues",
  login: string,
  from: Date,
  to: Date,
): Promise<Issue[]> => {
  const output = await search(
    async () =>
      await $`gh search ${kind} --author ${login} --created ${`${day(from)}..${day(to)}`} --limit 1000 --json ${fields[kind]}`
        .quiet()
        .nothrow(),
  );

  // SAFETY: `--json` asks for exactly the fields Issue declares.
  const found = JSON.parse(output) as Issue[];

  if (found.length < 1000 || day(from) === day(to)) {
    return found;
  }

  const middle = new Date((from.getTime() + to.getTime()) / 2);

  return [
    ...(await searchAll(kind, login, from, middle)),
    ...(await searchAll(kind, login, new Date(middle.getTime() + 86_400_000), to)),
  ];
};

const findClones = (roots: readonly string[], depth = 4): string[] => {
  const found: string[] = [];

  const walk = (dir: string, level: number) => {
    let names: string[];

    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      console.error(`github: can't read ${dir}, skipping its clones`);

      return;
    }

    if (names.includes(".git")) {
      found.push(dir);
    }

    if (level < depth) {
      for (const child of names.filter((name) => name !== ".git" && name !== "node_modules")) {
        walk(`${dir}/${child}`, level + 1);
      }
    }
  };

  for (const root of roots.filter((path) => existsSync(path))) {
    walk(root, 1);
  }

  return found.toSorted();
};

const githubRemote = /github\.com[:/](?<repo>[\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u;

const commitsIn = async (clone: string, authors: readonly string[]): Promise<Commit[]> => {
  const remote = await trimmed($`git -C ${clone} remote get-url origin`.quiet().nothrow());
  const repo = githubRemote.exec(remote)?.groups?.["repo"];

  if (repo === undefined) {
    return [];
  }

  const log =
    await $`git -C ${clone} log --branches --remotes ${authors.map((a) => `--author=${a}`)} --no-merges --format=${"%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1f%b%x1e"}`
      .quiet()
      .nothrow()
      .text();

  return log
    .split("\u001E")
    .map((record) => record.replace(/^\n/u, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", date = "", author = "", email = "", subject = "", body = ""] =
        record.split("\u001F");

      return { sha, date, author, email, subject, body, repo, remote, path: clone };
    });
};

const lower = (name: string) => name.toLowerCase();

const repoThing = (name: string): Row =>
  thing({
    id: `gh:repo:${lower(name)}`,
    kind: "repo",
    title: name,
    url: `https://github.com/${name}`,
  });

const closedAt = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.startsWith("0001-") ? null : iso(value);

const has = (dir: string, file: string) => existsSync(`${dir}/${file}`);

const reviewEvents = async function* reviewEvents(dir: string): AsyncGenerator<Row> {
  if (!has(dir, "reviews.jsonl")) {
    return;
  }

  const reviews = await Array.fromAsync(jsonl<Review>(`${dir}/reviews.jsonl`));
  const comments = await Array.fromAsync(jsonl<ReviewComment>(`${dir}/review_comments.jsonl`));
  const known = new Set(reviews.map((review) => review.id));
  const orphan = comments.find((comment) => !known.has(comment.pull_request_review_id));

  if (orphan !== undefined) {
    throw new Error(
      `review comment ${orphan.id} belongs to review ${orphan.pull_request_review_id}, which isn't in reviews.jsonl`,
    );
  }

  const byReview = Map.groupBy(comments, (comment) => comment.pull_request_review_id);

  for (const review of reviews) {
    const inline = byReview.get(review.id) ?? [];

    const said = [review.body, ...inline.map((comment) => comment.body)].filter(
      (body) => body !== "",
    );

    yield event({
      verb: "reviewed",
      thing: `gh:pr:${lower(review.repo)}#${review.pr}`,
      ts: iso(review.submitted_at),
      text: said.length > 0 ? said.join("\n\n") : null,
      key: `review:${review.id}`,
      extra: {
        state: review.state,
        url: review.html_url,
        commit: review.commit_id,
        comments: inline.map((comment) => ({
          id: comment.id,
          path: comment.path,
          line: comment.line,
          in_reply_to: comment.in_reply_to_id ?? null,
          url: comment.html_url,
          created_at: comment.created_at,
          body: comment.body,
        })),
      },
    });
  }
};

const commitEvents = async function* commitEvents(dir: string): AsyncGenerator<Row> {
  if (!has(dir, "commits.jsonl")) {
    return;
  }

  const bySha = new Map<string, { commit: Commit; repos: Set<string> }>();
  const slugs = new Map<string, string>();

  for await (const commit of jsonl<Commit>(`${dir}/commits.jsonl`)) {
    if (/github\.com[:/]/u.test(commit.remote)) {
      const repo = `gh:repo:${lower(commit.repo)}`;
      const seen = bySha.get(commit.sha);

      slugs.set(repo, commit.repo);

      if (seen === undefined) {
        bySha.set(commit.sha, { commit, repos: new Set([repo]) });
      } else {
        seen.repos.add(repo);
      }
    }
  }

  for (const name of slugs.values()) {
    yield repoThing(name);
  }

  for (const { commit, repos } of bySha.values()) {
    const sorted = [...repos].toSorted();

    yield event({
      verb: "committed",
      thing: sorted[0] ?? "",
      ts: iso(commit.date),
      text:
        commit.body.trim() === "" ? commit.subject : `${commit.subject}\n\n${commit.body.trim()}`,
      key: `commit:${commit.sha}`,
      extra: { author: commit.author, email: commit.email, repos: sorted },
    });
  }
};

export const github = ({
  clones = ["Developer", "Projects", "projects", "code", "src", "repos", "Documents/GitHub"].map(
    (dir) => `${homedir()}/${dir}`,
  ),
  authors,
}: GitHubOptions = {}) =>
  defineSource({
    name: "github",

    fetch: async ({ dir }) => {
      const login = await trimmed($`gh api user --jq .login`);
      const joined = new Date(await trimmed($`gh api user --jq .created_at`));
      const now = new Date();

      await Bun.write(
        `${dir}/prs.json`,
        JSON.stringify(await searchAll("prs", login, joined, now)),
      );
      await Bun.write(
        `${dir}/issues.json`,
        JSON.stringify(await searchAll("issues", login, joined, now)),
      );
      await $`gh api user/starred --paginate -H ${"Accept: application/vnd.github.star+json"} --jq ${".[] | {starred_at, repo: .repo | {full_name, description, html_url, language, topics, created_at}}"} > ${Bun.file(`${dir}/stars.jsonl`)}`;
      await Bun.write(
        `${dir}/reviewed.jsonl`,
        await search(
          async () =>
            await $`gh api --paginate ${`search/issues?q=reviewed-by:${login}+type:pr&per_page=100`} --jq .items[]`
              .quiet()
              .nothrow(),
        ),
      );

      let reviews = "";
      let comments = "";

      for await (const pr of jsonl<Reviewed>(`${dir}/reviewed.jsonl`)) {
        const repo = pr.repository_url.replace(/^.*\/repos\//u, "");
        const mine = `.[] | select(.user.login == "${login}") | {repo: "${repo}", pr: ${pr.number}} + .`;

        reviews +=
          await $`gh api --paginate ${`repos/${repo}/pulls/${pr.number}/reviews`} --jq ${mine}`.text();
        comments +=
          await $`gh api --paginate ${`repos/${repo}/pulls/${pr.number}/comments`} --jq ${mine}`.text();
      }

      await Bun.write(`${dir}/reviews.jsonl`, reviews);
      await Bun.write(`${dir}/review_comments.jsonl`, comments);

      const names = [
        login,
        await trimmed($`git config user.name`.quiet().nothrow()),
        await trimmed($`git config user.email`.quiet().nothrow()),
      ];

      const who = authors ?? names.filter((name) => name !== "");
      const commits: Commit[] = [];

      for (const clone of findClones(clones)) {
        commits.push(...(await commitsIn(clone, who)));
      }

      await writeJsonl(`${dir}/commits.jsonl`, commits);
    },

    async *rows({ dir }) {
      const mine = new Set<string>();

      for (const [kind, file] of [
        ["pr", "prs.json"],
        ["issue", "issues.json"],
      ] as const) {
        for (const item of has(dir, file) ? await json<readonly Issue[]>(`${dir}/${file}`) : []) {
          const name = item.repository.nameWithOwner;
          const id = `gh:${kind}:${lower(name)}#${item.number}`;

          mine.add(id);
          yield repoThing(name);
          yield thing({
            id,
            kind,
            title: item.title,
            text: item.body === "" ? null : item.body,
            url: item.url,
            created_at: iso(item.createdAt),
            extra: {
              state: item.state,
              draft: item.isDraft ?? null,
              closed_at: closedAt(item.closedAt),
            },
          });
          yield event({ verb: "opened", thing: id, ts: iso(item.createdAt) });
          yield link(id, "part_of", `gh:repo:${lower(name)}`);
        }
      }

      if (has(dir, "reviewed.jsonl")) {
        for await (const pr of jsonl<Reviewed>(`${dir}/reviewed.jsonl`)) {
          const name = pr.repository_url.replace(/^.*\/repos\//u, "");
          const id = `gh:pr:${lower(name)}#${pr.number}`;

          if (!mine.has(id)) {
            yield thing({
              id,
              kind: "pr",
              title: pr.title,
              text: pr.body === "" ? null : pr.body,
              url: pr.html_url,
              author: pr.user.login,
              created_at: iso(pr.created_at),
              extra: {
                state: pr.pull_request.merged_at === null ? pr.state : "merged",
                draft: pr.draft,
                closed_at: closedAt(pr.closed_at),
              },
            });
          }
        }
      }

      yield* reviewEvents(dir);
      yield* commitEvents(dir);

      if (has(dir, "stars.jsonl")) {
        for await (const star of jsonl<Star>(`${dir}/stars.jsonl`)) {
          const id = `gh:repo:${lower(star.repo.full_name)}`;

          yield thing({
            id,
            kind: "repo",
            title: star.repo.full_name,
            text: star.repo.description,
            url: star.repo.html_url,
            created_at: iso(star.repo.created_at),
            extra: { language: star.repo.language, topics: [...star.repo.topics] },
          });
          yield event({
            verb: "saved",
            thing: id,
            ts: iso(star.starred_at),
            collections: ["github stars"],
          });
        }
      }
    },
  });
