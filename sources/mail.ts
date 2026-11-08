import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as tcp } from "node:net";
import { homedir } from "node:os";
import { connect as secure } from "node:tls";
import { TextDecoder } from "node:util";

import { digest, event, iso, link, thing } from "../src/schema.ts";
import type { Row } from "../src/schema.ts";
import { defineSource, json } from "../src/source.ts";

export interface MailOptions {
  readonly host: string;
  readonly user: string;
  readonly addresses?: readonly string[];
  readonly mailboxes?: readonly string[];
  readonly port?: number;
  readonly tls?: boolean;
  readonly name?: string;
}

const KEPT_BYTES = 256 * 1024;
const BATCH = 100;
const FETCH_BUDGET_MS = 20 * 60_000;
const CRLF = "\r\n";

interface NetrcEntry {
  machine: string;
  login?: string;
  password?: string;
}

const netrcPassword = (host: string, user: string): string => {
  const file = process.env["NETRC"] ?? `${homedir()}/.netrc`;

  const words = (() => {
    try {
      return readFileSync(file, "utf-8").split(/\s+/u);
    } catch {
      return [];
    }
  })();

  let entry: NetrcEntry = { machine: "" };
  const entries: NetrcEntry[] = [];
  const tokens = words.values();

  for (const word of tokens) {
    if (word === "machine" || word === "default") {
      entry = { machine: word === "machine" ? (tokens.next().value ?? "") : "" };
      entries.push(entry);
    } else if (word === "login" || word === "password") {
      entry[word] = tokens.next().value ?? "";
    }
  }

  const found = entries.find(
    (e) => (e.machine === host || e.machine === "") && (e.login ?? user) === user,
  )?.password;

  if (found === undefined) {
    throw new Error(
      `no password for ${user} at ${host} in ${file}. Add the line "machine ${host} login ${user} password <app password>" and chmod 600 it.`,
    );
  }

  return found;
};

interface Response {
  readonly text: string;
  readonly literals: readonly Buffer[];
}

const imapSession = async (host: string, port: number, tls: boolean) => {
  const socket = tls ? secure({ host, port, servername: host }) : tcp({ host, port });
  const queue: Buffer[] = [];
  let head = Buffer.alloc(0);
  let ended: Error | null = null;
  let waiting = Promise.withResolvers<undefined>();

  const wake = () => {
    waiting.resolve(undefined);
  };

  socket.on("data", (chunk: Buffer) => {
    queue.push(chunk);
    wake();
  });
  socket.on("error", (error) => {
    ended = error;
    wake();
  });
  socket.on("close", () => {
    ended ??= new Error(`${host} closed the connection`);
    wake();
  });

  const wait = async () => {
    if (ended !== null) {
      throw ended;
    }

    waiting = Promise.withResolvers<undefined>();
    await waiting.promise;
  };

  const queued = () => queue.reduce((n, chunk) => n + chunk.length, 0);

  const read = async (): Promise<Response> => {
    let text = "";
    const literals: Buffer[] = [];

    for (;;) {
      while (!head.includes(CRLF)) {
        if (queue.length === 0) {
          await wait();
        }

        head = Buffer.concat([head, ...queue.splice(0)]);
      }

      const end = head.indexOf(CRLF);
      const line = head.subarray(0, end).toString("utf-8");
      head = head.subarray(end + 2);
      text += line;

      const size = /\{(?<size>\d+)\}$/u.exec(line)?.groups?.["size"];

      if (size === undefined) {
        return { text, literals };
      }

      const bytes = Number(size);

      while (head.length + queued() < bytes) {
        await wait();
      }

      head = Buffer.concat([head, ...queue.splice(0)]);
      literals.push(Buffer.from(head.subarray(0, bytes)));
      head = head.subarray(bytes);
    }
  };

  let tag = 0;

  const command = async (line: string, shown = line): Promise<Response[]> => {
    tag += 1;
    const id = `c${tag}`;
    socket.write(`${id} ${line}${CRLF}`);
    const untagged: Response[] = [];

    for (;;) {
      const response = await read();

      if (response.text.startsWith(`${id} `)) {
        if (!/^\S+ OK/iu.test(response.text)) {
          throw new Error(`${host}: ${shown} failed: ${response.text.slice(id.length + 1)}`);
        }

        return untagged;
      }

      untagged.push(response);
    }
  };

  const greeting = await read();

  if (!/^\* (?:OK|PREAUTH)/iu.test(greeting.text)) {
    throw new Error(`${host}: not an IMAP server: ${greeting.text}`);
  }

  return { command, close: () => socket.destroy() };
};

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const unquote = (value: string) =>
  value.startsWith('"') ? value.slice(1, -1).replaceAll(/\\(?<char>.)/gu, "$<char>") : value;

// https://www.rfc-editor.org/rfc/rfc3501#section-5.1.3
const mailboxName = (name: string): string =>
  name.replaceAll(/&(?<b64>[^-]*)-/gu, (_, b64: string) =>
    b64 === "" ? "&" : Buffer.from(b64.replaceAll(",", "/"), "base64").swap16().toString("utf16le"),
  );

type Progress = Record<string, { readonly validity: string; readonly uid: number }>;

const mailboxesToRead = (listed: readonly Response[]): string[] => {
  const boxes = listed.flatMap(({ text, literals }) => {
    const match = /^\* LIST \((?<flags>[^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (?<name>.*)$/iu.exec(
      text,
    )?.groups;

    if (match === undefined) {
      return [];
    }

    const raw = match["name"] ?? "";
    const name = /^\{\d+\}$/u.test(raw) ? (literals[0]?.toString("utf-8") ?? "") : unquote(raw);

    return [{ name, flags: (match["flags"] ?? "").toLowerCase().split(/\s+/u) }];
  });

  const all = boxes.find((box) => box.flags.includes("\\all"));

  return all === undefined
    ? boxes.flatMap((box) =>
        box.name.toUpperCase() === "INBOX" ||
        box.flags.includes("\\sent") ||
        box.flags.includes("\\archive")
          ? [box.name]
          : [],
      )
    : [all.name];
};

interface Part {
  readonly headers: Map<string, string>;
  readonly latin1Body: string;
}

const part = (raw: string): Part => {
  const split = /^\r?\n|\r?\n\r?\n/u.exec(raw);
  const head = split === null ? raw : raw.slice(0, split.index);
  const headers = new Map<string, string>();

  for (const line of Buffer.from(head, "latin1")
    .toString("utf-8")
    .split(/\r?\n(?![ \t])/u)) {
    const colon = line.indexOf(":");

    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      headers.set(
        name,
        headers.get(name) ??
          line
            .slice(colon + 1)
            .replaceAll(/\r?\n[ \t]+/gu, " ")
            .trim(),
      );
    }
  }

  return { headers, latin1Body: split === null ? "" : raw.slice(split.index + split[0].length) };
};

const decodeText = (bytes: Buffer, charset: string): string => {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf-8");
  }
};

const unhex = (text: string): string =>
  text.replaceAll(/[=](?<hex>[0-9a-f]{2})/giu, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );

// https://www.rfc-editor.org/rfc/rfc2047
const decodeWords = (value: string): string =>
  value
    .replaceAll(/\?=\s+=\?/gu, "?==?")
    .replaceAll(
      /[=]\?(?<charset>[^?]+)\?(?<kind>[bq])\?(?<text>[^?]*)\?=/giu,
      (_, charset: string, kind: string, text: string) =>
        decodeText(
          kind.toLowerCase() === "b"
            ? Buffer.from(text, "base64")
            : Buffer.from(unhex(text.replaceAll("_", " ")), "latin1"),
          charset.replace(/\*.*$/u, ""),
        ),
    );

const param = (header: string, name: string): string | null =>
  new RegExp(`;\\s*${name}\\s*=\\s*(?:"(?<quoted>[^"]*)"|(?<bare>[^;\\s]+))`, "iu")
    .exec(header)
    ?.slice(1)
    .find(Boolean) ?? null;

const bytesOf = ({ headers, latin1Body }: Part): Buffer => {
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();

  if (encoding === "base64") {
    return Buffer.from(latin1Body.replaceAll(/\s+/gu, ""), "base64");
  }

  if (encoding === "quoted-printable") {
    return Buffer.from(unhex(latin1Body.replaceAll(/[=]\r?\n/gu, "")), "latin1");
  }

  return Buffer.from(latin1Body, "latin1");
};

const fromHtml = (html: string): string =>
  html
    .replaceAll(/<(?<tag>style|script|head)\b[\s\S]*?<\/\k<tag>>/giu, "")
    .replaceAll(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d)>/giu, "\n")
    .replaceAll(/<[^>]*>/gu, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll(/[ \t]+/gu, " ")
    .replaceAll(/\s*\n\s*/gu, "\n");

const textOf = (message: Part): string | null => {
  const type = message.headers.get("content-type") ?? "text/plain";
  const media = type.split(";")[0]?.trim().toLowerCase() ?? "";
  const boundary = param(type, "boundary");

  if (media.startsWith("multipart/") && boundary !== null) {
    const line = `^--${boundary.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`;
    const [inside = ""] = message.latin1Body.split(new RegExp(`${line}--`, "mu"));

    const parts = inside
      .split(new RegExp(`${line}[ \\t]*\\r?$`, "mu"))
      .slice(1)
      .map((chunk) => part(chunk.replace(/^\r?\n/u, "")))
      .filter((p) => !/^attachment/iu.test(p.headers.get("content-disposition") ?? ""));

    const plain = parts.find((p) =>
      /^text\/plain/iu.test(p.headers.get("content-type") ?? "text/plain"),
    );

    for (const candidate of plain === undefined ? parts : [plain, ...parts]) {
      const text = textOf(candidate);

      if (text !== null) {
        return text;
      }
    }

    return null;
  }

  if (!media.startsWith("text/")) {
    return null;
  }

  const text = decodeText(bytesOf(message), param(type, "charset") ?? "utf-8");
  const readable = (media === "text/html" ? fromHtml(text) : text).trim();

  return readable === "" ? null : readable;
};

const addresses = (value: string | undefined): string[] =>
  (value ?? "").match(/[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+/gu)?.map((a) => a.toLowerCase()) ?? [];

const messageId = (value: string | undefined): string | null =>
  /<(?<id>[^>\s]+)>/u.exec(value ?? "")?.groups?.["id"] ?? null;

const messageRows = (raw: Buffer, mailbox: string, me: ReadonlySet<string>): Row[] => {
  const message = part(raw.toString("latin1"));

  const header = (name: string) => {
    const value = message.headers.get(name);

    return value === undefined || value === "" ? null : decodeWords(value);
  };

  const from = header("from");
  const subject = header("subject");
  const date = header("date");
  const ts = iso(date?.replaceAll(/\([^)]*\)/gu, "").trim());
  const own = messageId(header("message-id") ?? undefined);
  const id = `mail:${own ?? digest(from, date, subject)}`;
  const sender = addresses(from ?? undefined)[0] ?? null;
  const parent = messageId(header("in-reply-to") ?? undefined);

  return [
    thing({
      id,
      kind: "email",
      title: subject,
      text: textOf(message),
      author: from,
      created_at: ts,
      extra: {
        from: sender,
        to: addresses(header("to") ?? undefined),
        cc: addresses(header("cc") ?? undefined),
      },
    }),
    event({
      verb: sender !== null && me.has(sender) ? "sent" : "received",
      thing: id,
      ts,
      key: id,
      collections: [mailbox],
    }),
    ...(parent === null ? [] : [link(id, "replies_to", `mail:${parent}`)]),
  ];
};

export const mail = (options: MailOptions) => {
  const { host, user, tls = true } = options;
  const port = options.port ?? (tls ? 993 : 143);
  const me = new Set([user, ...(options.addresses ?? [])].map((a) => a.toLowerCase()));

  return defineSource({
    name: options.name ?? "mail",

    fetch: async ({ dir, state }) => {
      if (!tls && !["localhost", "127.0.0.1", "::1"].includes(host)) {
        throw new Error(`plain IMAP would send your password in the clear; use TLS for ${host}`);
      }

      const file = `${state}/progress.json`;
      const progress: Progress = existsSync(file) ? await json<Progress>(file) : {};
      const stop = Date.now() + FETCH_BUDGET_MS;
      const imap = await imapSession(host, port, tls);

      try {
        await imap.command(`LOGIN ${quote(user)} ${quote(netrcPassword(host, user))}`, "LOGIN");

        for (const mailbox of options.mailboxes ??
          mailboxesToRead(await imap.command('LIST "" "*"'))) {
          const folder = `${dir}/${encodeURIComponent(mailboxName(mailbox))}`;
          const opened = await imap.command(`EXAMINE ${quote(mailbox)}`);

          const validity =
            opened
              .map(
                ({ text }) => /\[UIDVALIDITY (?<validity>\d+)\]/iu.exec(text)?.groups?.["validity"],
              )
              .find(Boolean) ?? "";

          const held = progress[mailbox];
          const last = held?.validity === validity ? held.uid : 0;
          const searched = await imap.command(`UID SEARCH UID ${last + 1}:*`);

          const uids = searched
            .flatMap(({ text }) => (text.startsWith("* SEARCH") ? text.split(" ").slice(2) : []))
            .map(Number)
            .filter((uid) => uid > last)
            .toSorted((a, b) => a - b);

          mkdirSync(folder);

          for (let i = 0; i < uids.length && Date.now() < stop; i += BATCH) {
            const batch = uids.slice(i, i + BATCH);

            for (const { text, literals } of await imap.command(
              `UID FETCH ${batch.join(",")} (UID BODY.PEEK[]<0.${KEPT_BYTES}>)`,
            )) {
              const uid = /\bUID (?<uid>\d+)/iu.exec(text)?.groups?.["uid"];
              const [body] = literals;

              if (uid !== undefined && body !== undefined) {
                await Bun.write(`${folder}/${uid}.eml`, body);
              }
            }

            progress[mailbox] = { validity, uid: batch.at(-1) ?? last };
          }
        }

        await imap.command("LOGOUT").catch(() => []);
      } finally {
        imap.close();
      }

      writeFileSync(file, JSON.stringify(progress));
    },

    *rows({ dir }) {
      for (const folder of readdirSync(dir).toSorted()) {
        const mailbox = decodeURIComponent(folder);

        const uids = readdirSync(`${dir}/${folder}`)
          .filter((name) => name.endsWith(".eml"))
          .map((name) => name.slice(0, -".eml".length))
          .toSorted((a, b) => Number(a) - Number(b));

        for (const uid of uids) {
          yield* messageRows(readFileSync(`${dir}/${folder}/${uid}.eml`), mailbox, me);
        }
      }
    },
  });
};
