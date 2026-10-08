import { Database } from "bun:sqlite";
import { homedir } from "node:os";

import { event, thing } from "../src/schema.ts";
import { defineSource, jsonl, type Source, writeJsonl } from "../src/source.ts";

export interface Chat {
  readonly guid: string;
  readonly name: string | null;
  readonly group: boolean;
  readonly handles: ReadonlyArray<string>;
}

export interface Message {
  readonly guid: string;
  readonly chat: string;
  readonly handle: string | null;
  readonly from_me: boolean;
  readonly ts: string;
  readonly text: string | null;
  readonly service: string;
  readonly attachments: boolean;
  readonly reaction: string | null;
}

interface MessageRow {
  readonly guid: string;
  readonly text: string | null;
  readonly body: Uint8Array | null;
  readonly date: number;
  readonly from_me: number;
  readonly associated: number;
  readonly service: string;
  readonly attachments: number;
  readonly handle: string | null;
  readonly chat: string;
}

/** Messages files a 1:1 chat as `any;-;<handle>`, and some messages have no chat row of their own. */
const oneToOne = (handle: string) => `'any;-;' || ${handle}`;

const chatsSql = `
  SELECT guid, nullif(display_name, '') AS name, style = 43 AS "group",
    (SELECT json_group_array(id) FROM (
      SELECT DISTINCT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
      WHERE j.chat_id = chat.ROWID ORDER BY h.id)) AS handles
  FROM chat`;

const messagesSql = `
  SELECT m.guid, m.text, m.attributedBody AS body, m.date, m.is_from_me AS from_me,
    m.associated_message_type AS associated, m.service, m.cache_has_attachments AS attachments,
    h.id AS handle,
    coalesce(
      (SELECT min(c.guid) FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id WHERE j.message_id = m.ROWID),
      ${oneToOne("h.id")}) AS chat
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.item_type = 0 AND m.date >= $after
  ORDER BY m.date`;

const appleEpoch = Date.UTC(2001, 0, 1);

/** `message.date` counts from 2001-01-01 UTC: nanoseconds since macOS 10.13, seconds before. */
const appleTime = (date: number): string =>
  new Date(appleEpoch + (date > 1e11 ? date / 1e6 : date * 1000)).toISOString();

const appleDate = (iso: string): number => (Date.parse(iso) - appleEpoch) * 1e6;

/**
 * The plain text of an NSAttributedString typedstream: `NSString`, four header bytes, `+`, a length
 * (one byte below 0x80, or 0x81 + uint16 LE, or 0x82 + uint32 LE), then that many UTF-8 bytes.
 */
const bodyText = (body: Uint8Array): string | null => {
  const bytes = Buffer.from(body);
  const plus = bytes.indexOf("NSString") + 12;
  const tag = bytes[plus + 1] ?? 0xff;
  const width = tag < 0x80 ? 0 : tag === 0x81 ? 2 : tag === 0x82 ? 4 : null;

  if (plus < 12 || bytes[plus] !== 0x2b || width === null) {
    return null;
  }

  const start = plus + 2 + width;

  return bytes.toString("utf8", start, start + (width === 0 ? tag : bytes.readUIntLE(plus + 2, width)));
};

const tapbacks = ["love", "like", "dislike", "laugh", "emphasize", "question", "emoji", "sticker"];

const reactionOf = (associated: number): string | null =>
  associated >= 2000 && associated < 4000
    ? `${associated >= 3000 ? "removed " : ""}${tapbacks[associated % 1000] ?? "reaction"}`
    : null;

export interface Options {
  /** Messages that never leave chat.db: they are dropped before the snapshot is written. */
  readonly drop?: (message: Message, chat: Chat | undefined) => boolean;
}

/** Your iMessage and SMS conversations, read from the Messages database on this Mac (needs Full Disk Access). */
export const imessage = ({ drop }: Options = {}): Source =>
  defineSource({
    name: "imessage",

    /** Starts a day before the last snapshot so no timezone can open a gap; repeats merge away by ID. */
    fetch: async ({ dir, since }) => {
      const db = new Database(`${homedir()}/Library/Messages/chat.db`, { readonly: true, strict: true });
      const after = since === null ? 0 : appleDate(since) - 86_400 * 1e9;

      try {
        const chats = db
          .query<{ guid: string; name: string | null; group: number; handles: string }, []>(chatsSql)
          .all()
          .map((row): Chat => ({
            guid: row.guid,
            name: row.name,
            group: row.group === 1,
            handles: JSON.parse(row.handles),
          }));
        const byGuid = new Map(chats.map((chat) => [chat.guid, chat]));
        const messages = db
          .query<MessageRow, { after: number }>(messagesSql)
          .all({ after })
          .map((row): Message => ({
            guid: row.guid,
            chat: row.chat,
            handle: row.handle,
            from_me: row.from_me === 1,
            ts: appleTime(row.date),
            text: row.text ?? (row.body === null ? null : bodyText(row.body)),
            service: row.service,
            attachments: row.attachments === 1,
            reaction: reactionOf(row.associated),
          }))
          .filter((message) => drop?.(message, byGuid.get(message.chat)) !== true);

        await writeJsonl(`${dir}/chats.jsonl`, chats);
        await writeJsonl(`${dir}/messages.jsonl`, messages);
      } finally {
        db.close();
      }
    },

    rows: async function* ({ dir }) {
      const chats = new Map<string, Chat>();

      for await (const chat of jsonl<Chat>(`${dir}/chats.jsonl`)) {
        chats.set(chat.guid, chat);
      }

      const seen = new Set<string>();

      for await (const message of jsonl<Message>(`${dir}/messages.jsonl`)) {
        const id = `chat:imessage:${message.chat}`;
        const chat = chats.get(message.chat);

        if (!seen.has(id)) {
          seen.add(id);
          yield thing({
            id,
            kind: "chat",
            title: chat?.name ?? chat?.handles.join(", ") ?? message.handle,
            extra: { group: chat?.group ?? false, handles: [...(chat?.handles ?? [])] },
          });
        }

        yield event({
          verb: message.from_me ? "sent" : "received",
          thing: id,
          ts: message.ts,
          text: message.text === "" ? null : message.text,
          key: message.guid,
          extra: {
            from: message.from_me ? null : message.handle,
            service: message.service,
            attachments: message.attachments,
            reaction: message.reaction,
          },
        });
      }
    },
  });
