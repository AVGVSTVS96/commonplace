import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

import { event, iso, link, type Row, thing } from "../src/schema.ts";
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
    readonly topics: ReadonlyArray<string>;
    readonly created_at: string;
  };
}

export interface GitHubOptions {
  /** Folders holding your clones, searched four levels deep for commits. */
  readonly clones?: ReadonlyArray<string>;
  /** Who you are in `git log --author`: names, emails or patterns. Defaults to your git name and email and your GitHub login. */
  readonly authors?: ReadonlyArray<string>;
}

const fields = {
  prs: "repository,number,title,body,state,isDraft,createdAt,closedAt,url",
  issues: "repository,number,title,body,state,createdAt,closedAt,url",
};

const day = (date: Date) => date.toISOString().slice(0, 10);

/** GitHub search stops at 1,000 results, so a range that fills up is searched again in halves. */
const searchAll = async (
  kind: "prs" | "issues",
  login: string,
  from: Date,
  to: Date,
): Promise<Array<Issue>> => {
  const found =
    (await $`gh search ${kind} --author ${login} --created ${`${day(from)}..${day(to)}`} --limit 1000 --json ${fields[kind]}`.json()) as Array<Issue>;

  if (found.length < 1000 || day(from) === day(to)) {
    return found;
  }

  const middle = new Date((from.getTime() + to.getTime()) / 2);

  return [
    ...(await searchAll(kind, login, from, middle)),
    ...(await searchAll(kind, login, new Date(middle.getTime() + 86_400_000), to)),
  ];
};

/** Every git clone under `roots`, as deep as `depth`. Folders this process may not read are passed over. */
const findClones = (roots: ReadonlyArray<string>, depth = 4): Array<string> => {
  const found: Array<string> = [];
  const walk = (dir: string, level: number) => {
    let names: Array<string>;
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

/** Your commits in every clone whose origin is on GitHub, one line per commit per clone. */
const commitsIn = async (clone: string, authors: ReadonlyArray<string>): Promise<Array<Commit>> => {
  const remote = (await $`git -C ${clone} remote get-url origin`.quiet().nothrow().text()).trim();
  const repo = /github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?\/?$/.exec(remote)?.[1];

  if (repo === undefined) {
    return [];
  }

  const log =
    await $`git -C ${clone} log --branches --remotes ${authors.map((a) => `--author=${a}`)} --no-merges --format=${"%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1f%b%x1e"}`
      .quiet()
      .nothrow()
      .text();

  return log
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", date = "", author = "", email = "", subject = "", body = ""] = record.split("\x1f");

      return { sha, date, author, email, subject, body, repo, remote, path: clone };
    });
};

const lower = (name: string) => name.toLowerCase();

const repoThing = (name: string): Row =>
  thing({ id: `gh:repo:${lower(name)}`, kind: "repo", title: name, url: `https://github.com/${name}` });

/** `gh search` reports a pull request that was never closed with Go's zero time. */
const closedAt = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.startsWith("0001-") ? null : iso(value);

const has = (dir: string, file: string) => existsSync(`${dir}/${file}`);

/**
 * Your pull requests and issues, the pull requests you reviewed with your reviews and inline comments,
 * your stars, and your commits in local clones of GitHub repos, through the GitHub CLI (`gh auth login`).
 */
export const github = ({
  clones = ["Developer", "Projects", "projects", "code", "src", "repos", "Documents/GitHub"].map(
    (dir) => `${homedir()}/${dir}`,
  ),
  authors,
}: GitHubOptions = {}) =>
  defineSource({
    name: "github",

    fetch: async ({ dir }) => {
      const login = (await $`gh api user --jq .login`.text()).trim();
      const joined = new Date((await $`gh api user --jq .created_at`.text()).trim());
      const now = new Date();

      await Bun.write(`${dir}/prs.json`, JSON.stringify(await searchAll("prs", login, joined, now)));
      await Bun.write(`${dir}/issues.json`, JSON.stringify(await searchAll("issues", login, joined, now)));
      await $`gh api user/starred --paginate -H ${"Accept: application/vnd.github.star+json"} --jq ${".[] | {starred_at, repo: .repo | {full_name, description, html_url, language, topics, created_at}}"} > ${Bun.file(`${dir}/stars.jsonl`)}`;

      const reviewed = (
        await $`gh api --paginate ${`search/issues?q=reviewed-by:${login}+type:pr&per_page=100`} --jq .items[]`.text()
      )
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Reviewed);
      const reviews: Array<unknown> = [];
      const comments: Array<unknown> = [];
      const mine = `.[] | select(.user.login == "${login}")`;

      for (const pr of reviewed) {
        const repo = pr.repository_url.replace(/^.*\/repos\//, "");
        const lines = async (path: string) =>
          (await $`gh api --paginate ${path} --jq ${mine}`.text())
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => Object.assign({ repo, pr: pr.number }, JSON.parse(line)));

        reviews.push(...(await lines(`repos/${repo}/pulls/${pr.number}/reviews`)));
        comments.push(...(await lines(`repos/${repo}/pulls/${pr.number}/comments`)));
      }

      await writeJsonl(`${dir}/reviewed.jsonl`, reviewed);
      await writeJsonl(`${dir}/reviews.jsonl`, reviews);
      await writeJsonl(`${dir}/review_comments.jsonl`, comments);

      const names = [
        login,
        (await $`git config user.name`.quiet().nothrow().text()).trim(),
        (await $`git config user.email`.quiet().nothrow().text()).trim(),
      ];
      const who = authors ?? names.filter((name) => name !== "");
      const commits: Array<Commit> = [];

      for (const clone of findClones(clones)) {
        commits.push(...(await commitsIn(clone, who)));
      }
      await writeJsonl(`${dir}/commits.jsonl`, commits);
    },

    /** Snapshots from before a file was fetched simply don't have it. */
    rows: async function* ({ dir }) {
      const mine = new Set<string>();

      for (const [kind, file] of [
        ["pr", "prs.json"],
        ["issue", "issues.json"],
      ] as const) {
        for (const item of has(dir, file) ? await json<ReadonlyArray<Issue>>(`${dir}/${file}`) : []) {
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
            extra: { state: item.state, draft: item.isDraft ?? null, closed_at: closedAt(item.closedAt) },
          });
          yield event({ verb: "opened", thing: id, ts: iso(item.createdAt) });
          yield link(id, "part_of", `gh:repo:${lower(name)}`);
        }
      }

      if (has(dir, "reviewed.jsonl")) {
        for await (const pr of jsonl<Reviewed>(`${dir}/reviewed.jsonl`)) {
          const name = pr.repository_url.replace(/^.*\/repos\//, "");
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

      // One event per review. GitHub files every inline comment under a review, so comments ride on theirs.
      if (has(dir, "reviews.jsonl")) {
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
          const said = [review.body, ...inline.map((comment) => comment.body)].filter((body) => body !== "");

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
      }

      // One line per commit per clone, and forks share SHAs, so each SHA is one event, on the
      // alphabetically first repo that has it; `extra.repos` lists them all.
      if (has(dir, "commits.jsonl")) {
        const bySha = new Map<string, { commit: Commit; repos: Set<string> }>();
        const slugs = new Map<string, string>();

        for await (const commit of jsonl<Commit>(`${dir}/commits.jsonl`)) {
          if (/github\.com[:/]/.test(commit.remote)) {
            const repo = `gh:repo:${lower(commit.repo)}`;
            slugs.set(repo, commit.repo);
            const seen = bySha.get(commit.sha);
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
            text: commit.body.trim() === "" ? commit.subject : `${commit.subject}\n\n${commit.body.trim()}`,
            key: `commit:${commit.sha}`,
            extra: { author: commit.author, email: commit.email, repos: sorted },
          });
        }
      }

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
          yield event({ verb: "saved", thing: id, ts: iso(star.starred_at), collections: ["github stars"] });
        }
      }
    },
  });
