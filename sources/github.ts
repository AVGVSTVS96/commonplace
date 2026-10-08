import { $ } from "bun";

import { event, iso, link, thing } from "../src/schema.ts";
import { defineSource, json, jsonl } from "../src/source.ts";

interface Repository {
  readonly nameWithOwner: string;
}

interface Issue {
  readonly repository: Repository;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly createdAt: string;
  readonly url: string;
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

const issueFields = "repository,number,title,body,state,createdAt,url";

const repo = (name: string) =>
  thing({ id: `gh:repo:${name}`, kind: "repo", title: name, url: `https://github.com/${name}` });

/** Your pull requests, issues, and stars, through the GitHub CLI (`gh auth login`). */
export default defineSource({
  name: "github",

  fetch: async ({ dir }) => {
    const login = (await $`gh api user --jq .login`.text()).trim();

    await $`gh search prs --author ${login} --limit 1000 --json ${issueFields} > ${Bun.file(`${dir}/prs.json`)}`;
    await $`gh search issues --author ${login} --limit 1000 --json ${issueFields} > ${Bun.file(`${dir}/issues.json`)}`;
    await $`gh api user/starred --paginate -H ${"Accept: application/vnd.github.star+json"} --jq ${".[] | {starred_at, repo: .repo | {full_name, description, html_url, language, topics, created_at}}"} > ${Bun.file(`${dir}/stars.jsonl`)}`;
  },

  rows: async function* ({ dir }) {
    for (const [kind, file] of [
      ["pr", "prs.json"],
      ["issue", "issues.json"],
    ] as const) {
      for (const item of await json<ReadonlyArray<Issue>>(`${dir}/${file}`)) {
        const name = item.repository.nameWithOwner;
        const id = `gh:${kind}:${name}#${item.number}`;

        yield repo(name);
        yield thing({
          id,
          kind,
          title: item.title,
          text: item.body === "" ? null : item.body,
          url: item.url,
          created_at: iso(item.createdAt),
          extra: { state: item.state },
        });
        yield event({ verb: "opened", thing: id, ts: iso(item.createdAt) });
        yield link(id, "part_of", `gh:repo:${name}`);
      }
    }

    for await (const star of jsonl<Star>(`${dir}/stars.jsonl`)) {
      const id = `gh:repo:${star.repo.full_name}`;

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
  },
});
