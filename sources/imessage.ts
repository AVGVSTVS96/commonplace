import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { event, thing } from "../src/schema.ts";
import { defineSource, jsonl, type Source, writeJsonl } from "../src/source.ts";

export interface Chat {
  readonly guid: string;
  readonly name: string | null;
  readonly service: string | null;
  readonly group: boolean;
  readonly handles: ReadonlyArray<string>;
  /** A 1:1 chat Messages never made a row for, named after its one handle. */
  readonly inferred: boolean;
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
  /** What a tapback, sticker or app message does to the message it points at. */
  readonly associated: {
    readonly kind: string;
    readonly removed: boolean;
    readonly to: string | null;
  } | null;
  /** Filed under its sender's 1:1 chat because Messages joined it to none. */
  readonly inferred: boolean;
}

/** Messages files a 1:1 chat as `any;-;<handle>`, and some messages have no chat row of their own. */
const oneToOne = (handle: string) => `'any;-;' || ${handle}`;

const chatsSql = `
  SELECT guid, nullif(display_name, '') AS name, service_name AS service, style = 43 AS "group",
    (SELECT json_group_array(id) FROM (
      SELECT DISTINCT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
      WHERE j.chat_id = chat.ROWID ORDER BY h.id)) AS handles,
    0 AS inferred
  FROM chat
  UNION ALL
  SELECT ${oneToOne("h.id")}, NULL, min(m.service), 0, json_array(h.id), 1
  FROM message m JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.item_type = 0
    AND NOT EXISTS (SELECT 1 FROM chat_message_join j WHERE j.message_id = m.ROWID)
    AND NOT EXISTS (SELECT 1 FROM chat c WHERE c.guid = ${oneToOne("h.id")})
  GROUP BY h.id
  ORDER BY 1`;

const messagesSql = `
  SELECT m.guid, m.text, m.attributedBody AS body, cast(m.date AS TEXT) AS date, m.is_from_me AS from_me,
    m.associated_message_type AS associated, m.associated_message_guid AS associated_to, m.service,
    m.cache_has_attachments AS attachments, h.id AS handle,
    coalesce(
      (SELECT min(c.guid) FROM chat_message_join j JOIN chat c ON c.ROWID = j.chat_id WHERE j.message_id = m.ROWID),
      ${oneToOne("h.id")}) AS chat,
    NOT EXISTS (SELECT 1 FROM chat_message_join j WHERE j.message_id = m.ROWID) AS inferred
  FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.item_type = 0 AND m.date >= $after
  ORDER BY m.ROWID`;

interface MessageRow {
  readonly guid: string;
  readonly text: string | null;
  readonly body: Uint8Array | null;
  readonly date: string;
  readonly from_me: number;
  readonly associated: number;
  readonly associated_to: string | null;
  readonly service: string;
  readonly attachments: number;
  readonly handle: string | null;
  readonly chat: string | null;
  readonly inferred: number;
}

const appleEpoch = 978_307_200_000n;

/** `message.date` counts from 2001-01-01 UTC: nanoseconds since macOS 10.13, seconds before. */
const appleTime = (date: bigint): string =>
  new Date(Number(appleEpoch + (date > 100_000_000_000n ? date / 1_000_000n : date * 1000n))).toISOString();

const appleDate = (iso: string): bigint => (BigInt(Date.parse(iso)) - appleEpoch) * 1_000_000n;

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

const associationOf = (type: number, to: string | null): Message["associated"] =>
  type === 0
    ? null
    : {
        kind:
          type === 2 || type === 3
            ? "app"
            : type === 1000
              ? "sticker"
              : type >= 2000 && type < 4000
                ? (tapbacks[type % 1000] ?? "reaction")
                : String(type),
        removed: type >= 3000 && type < 4000,
        to,
      };

/** Every chat, and every message on or after `after` (Apple time), from a Messages database. */
const read = (file: string, after: bigint) => {
  const db = new Database(file, { readonly: true, strict: true });

  try {
    const chats = db
      .query<
        {
          guid: string;
          name: string | null;
          service: string | null;
          group: number;
          handles: string;
          inferred: number;
        },
        []
      >(chatsSql)
      .all()
      .map((row): Chat => ({
        guid: row.guid,
        name: row.name,
        service: row.service,
        group: row.group === 1,
        handles: JSON.parse(row.handles),
        inferred: row.inferred === 1,
      }));
    const messages = db
      .query<MessageRow, { after: bigint }>(messagesSql)
      .all({ after })
      .flatMap((row): Array<Message> =>
        row.chat === null
          ? []
          : [
              {
                guid: row.guid,
                chat: row.chat,
                handle: row.handle,
                from_me: row.from_me === 1,
                ts: appleTime(BigInt(row.date)),
                text: row.text ?? (row.body === null ? null : bodyText(row.body)),
                service: row.service,
                attachments: row.attachments === 1,
                associated: associationOf(row.associated, row.associated_to),
                inferred: row.inferred === 1,
              },
            ],
      );

    return { chats, messages };
  } finally {
    db.close();
  }
};

export interface IMessageOptions {
  /** Messages that never leave Messages: they are dropped before the snapshot is written. */
  readonly drop?: (message: Message, chat: Chat | undefined) => boolean;
}

/**
 * Your iMessage and SMS conversations, read from the Messages database on this Mac (needs Full Disk Access).
 * A snapshot holds the chats and the new days' messages, or a whole `chat.db`, like a copy from an old Mac.
 */
export const imessage = ({ drop }: IMessageOptions = {}): Source => {
  const kept = (chats: ReadonlyArray<Chat>, messages: ReadonlyArray<Message>) => {
    const byGuid = new Map(chats.map((chat) => [chat.guid, chat]));

    return messages.filter((message) => drop?.(message, byGuid.get(message.chat)) !== true);
  };

  return defineSource({
    name: "imessage",
    watch: [`${homedir()}/Library/Messages/chat.db-wal`],

    /** Starts a day before the last snapshot so no timezone can open a gap; repeats merge away by ID. */
    fetch: async ({ dir, since }) => {
      const after = since === null ? 0n : appleDate(since) - 86_400_000_000_000n;
      const { chats, messages } = read(`${homedir()}/Library/Messages/chat.db`, after);

      await writeJsonl(`${dir}/chats.jsonl`, chats);
      await writeJsonl(`${dir}/messages.jsonl`, kept(chats, messages));
    },

    rows: async function* ({ dir }) {
      const whole = existsSync(`${dir}/chat.db`) ? read(`${dir}/chat.db`, 0n) : null;
      const chats = whole?.chats ?? (await Array.fromAsync(jsonl<Chat>(`${dir}/chats.jsonl`)));
      const messages = whole === null ? jsonl<Message>(`${dir}/messages.jsonl`) : kept(chats, whole.messages);

      for (const chat of chats) {
        yield thing({
          id: `chat:imessage:${chat.guid}`,
          kind: "chat",
          title: chat.name ?? chat.handles.join(", "),
          extra: {
            service: chat.service,
            group: chat.group,
            handles: [...chat.handles],
            inferred: chat.inferred,
          },
        });
      }

      for await (const message of messages) {
        yield event({
          verb: message.from_me ? "sent" : "received",
          thing: `chat:imessage:${message.chat}`,
          ts: message.ts,
          text: message.text === "" ? null : message.text,
          key: message.guid,
          extra: {
            service: message.service,
            from: message.from_me ? null : message.handle,
            attachments: message.attachments,
            associated: message.associated,
            inferred_chat: message.inferred,
          },
        });
      }
    },
  });
};
