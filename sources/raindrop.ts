import { readdirSync } from "node:fs";

import { event, iso, thing, urlRef } from "../src/schema.ts";
import { csv, defineSource } from "../src/source.ts";

const columns = [
  "id",
  "title",
  "note",
  "excerpt",
  "url",
  "folder",
  "tags",
  "created",
  "cover",
  "highlights",
  "favorite",
];

const orNull = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;

/**
 * Your Raindrop.io bookmarks, from the CSV export (Settings → Backups, or Export in any collection) dropped
 * into the snapshot. Folders become collections ("Unsorted" is Raindrop's name for none); tags, highlights
 * and favorites ride along on the save.
 */
export default defineSource({
  name: "raindrop",
  rows: function* ({ dir }) {
    for (const name of readdirSync(dir)
      .filter((file) => file.endsWith(".csv"))
      .toSorted()) {
      const file = `${dir}/${name}`;
      const [header = [], ...records] = csv(file);

      if (header.join(",") !== columns.join(",")) {
        throw new Error(`${file}: not a Raindrop export, its header is ${header.join(",")}`);
      }

      for (const [i, cells] of records.entries()) {
        const bookmark = Object.fromEntries(columns.map((column, c) => [column, cells[c]]));
        const url = bookmark["url"] ?? "";
        const target = urlRef(url);
        const created = iso(bookmark["created"]);

        if (target === null || created === null) {
          throw new Error(`${file} (record ${i + 2}): no http(s) URL or creation time`);
        }

        yield thing({
          ...target,
          title: orNull(bookmark["title"]),
          text: orNull(bookmark["excerpt"]),
          url,
          extra: { cover: orNull(bookmark["cover"]) },
        });
        yield event({
          verb: "saved",
          thing: target.id,
          ts: created,
          text: orNull(bookmark["note"]),
          collections:
            bookmark["folder"] === "Unsorted" || bookmark["folder"] === undefined ? [] : [bookmark["folder"]],
          extra: {
            raindrop_id: bookmark["id"] ?? null,
            tags: (bookmark["tags"] ?? "")
              .split(",")
              .map((tag) => tag.trim())
              .filter((tag) => tag !== ""),
            highlights: orNull(bookmark["highlights"]),
            favorite: bookmark["favorite"] === "true",
          },
        });
      }
    }
  },
});
