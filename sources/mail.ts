import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as tcp } from "node:net";
import { homedir } from "node:os";
import { connect as secure } from "node:tls";

import { digest, event, iso, link, type Row, thing } from "../src/schema.ts";
import { defineSource } from "../src/source.ts";

export interface MailOptions {
  /** The IMAP server, like `imap.gmail.com` or `imap.fastmail.com`. */
  readonly host: string;
  /** The account you sign in as, usually your address. */
  readonly user: string;
  /** Your other addresses, so mail from them counts as sent. */
  readonly addresses?: ReadonlyArray<string>;
  /** Which mailboxes to read. Defaults to the server's All Mail if it has one, else the inbox, Sent and Archive. */
  readonly mailboxes?: ReadonlyArray<string>;
  /** Defaults to 993 with TLS. Plain IMAP (`tls: false`, port 143) is allowed only to this machine, like Proton Mail Bridge. */
  readonly port?: number;
  readonly tls?: boolean;
  /** Names the source, for a second account. Defaults to `mail`. */
  readonly name?: string;
}

/** Bytes kept of each message: all of its text, and the start of any attachment. */
const KEEP = 256 * 1024;
const BATCH = 100;
/** Under sync's 30-minute limit: a first fetch of years of mail stops here and the next sync goes on. */
const BUDGET_MS = 20 * 60_000;
const CRLF = "\r\n";

/** The password for `user` at `host` from `~/.netrc` (or `$NETRC`), where curl and git look too. */
const password = (host: string, user: string): string => {
  const file = process.env["NETRC"] ?? `${homedir()}/.netrc`;
  const words = (() => {
    try {
      return readFileSync(file, "utf8").split(/\s+/);
    } catch {
      return [];
    }
  })();
  let entry: Record<string, string> = {};
  const entries: Array<Record<string, string>> = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";

    if (word === "machine" || word === "default") {
      entry = word === "machine" ? { machine: words[++i] ?? "" } : { machine: "" };
      entries.push(entry);
    } else if (word === "login" || word === "password") {
      entry[word] = words[++i] ?? "";
    }
  }

  const found = entries.find(
    (e) => (e["machine"] === host || e["machine"] === "") && (e["login"] ?? user) === user,
  )?.["password"];

  if (found === undefined) {
    throw new Error(
      `no password for ${user} at ${host} in ${file}. Add the line "machine ${host} login ${user} password <app password>" and chmod 600 it.`,
    );
  }

  return found;
};

interface Response {
  readonly text: string;
  readonly literals: ReadonlyArray<Buffer>;
}

const idle = () => {};

/** An IMAP connection: send a command, get its untagged responses, literals read in place. */
const session = async (host: string, port: number, tls: boolean) => {
  const socket = tls ? secure({ host, port, servername: host }) : tcp({ host, port });
  const queue: Array<Buffer> = [];
  let head = Buffer.alloc(0);
  let ended: Error | null = null;
  let wake = idle;

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
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  const queued = () => queue.reduce((n, chunk) => n + chunk.length, 0);

  const read = async (): Promise<Response> => {
    let text = "";
    const literals: Array<Buffer> = [];

    for (;;) {
      while (!head.includes(CRLF)) {
        if (queue.length === 0) {
          await wait();
        }
        head = Buffer.concat([head, ...queue.splice(0)]);
      }
      const end = head.indexOf(CRLF);
      const line = head.subarray(0, end).toString("utf8");
      head = head.subarray(end + 2);
      text += line;

      const literal = /\{(\d+)\}$/.exec(line);

      if (literal === null) {
        return { text, literals };
      }

      const size = Number(literal[1]);

      while (head.length + queued() < size) {
        await wait();
      }
      head = Buffer.concat([head, ...queue.splice(0)]);
      literals.push(Buffer.from(head.subarray(0, size)));
      head = head.subarray(size);
    }
  };

  let tag = 0;

  const command = async (line: string, shown = line): Promise<Array<Response>> => {
    const id = `c${++tag}`;
    socket.write(`${id} ${line}${CRLF}`);
    const untagged: Array<Response> = [];

    for (;;) {
      const response = await read();

      if (response.text.startsWith(`${id} `)) {
        if (!/^\S+ OK/i.test(response.text)) {
          throw new Error(`${host}: ${shown} failed: ${response.text.slice(id.length + 1)}`);
        }
        return untagged;
      }
      untagged.push(response);
    }
  };

  const greeting = await read();

  if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) {
    throw new Error(`${host}: not an IMAP server: ${greeting.text}`);
  }

  return { command, close: () => socket.destroy() };
};

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** IMAP's modified UTF-7 mailbox names (RFC 3501 5.1.3): `Envoy&AOk-s` is `Envoyés`. */
const mailboxName = (name: string): string =>
  name.replaceAll(/&([^-]*)-/g, (_, b64: string) =>
    b64 === "" ? "&" : Buffer.from(b64.replaceAll(",", "/"), "base64").swap16().toString("utf16le"),
  );

/** Per mailbox, the last UID taken and the UIDVALIDITY it belongs to. */
type Progress = Record<string, { readonly validity: string; readonly uid: number }>;

/** The mailboxes worth reading: All Mail where there is one (Gmail), else the inbox, Sent and Archive. */
const chosen = (listed: ReadonlyArray<Response>): Array<string> => {
  const boxes = listed.flatMap(({ text, literals }) => {
    const match = /^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.*)$/i.exec(text);

    if (match === null) {
      return [];
    }

    const raw = match[2] ?? "";
    const name = /^\{\d+\}$/.test(raw)
      ? (literals[0]?.toString("utf8") ?? "")
      : raw.startsWith('"')
        ? raw.slice(1, -1).replaceAll(/\\(.)/g, "$1")
        : raw;

    return [{ name, flags: (match[1] ?? "").toLowerCase().split(/\s+/) }];
  });
  const all = boxes.find((box) => box.flags.includes("\\all"));

  return all !== undefined
    ? [all.name]
    : boxes
        .filter(
          (box) =>
            box.name.toUpperCase() === "INBOX" ||
            box.flags.includes("\\sent") ||
            box.flags.includes("\\archive"),
        )
        .map((box) => box.name);
};

interface Part {
  readonly headers: Map<string, string>;
  /** The body as bytes, one char per byte. */
  readonly body: string;
}

/** Splits headers from body. Header names are lowercased; folded lines are joined. */
const part = (raw: string): Part => {
  const split = /^\r?\n|\r?\n\r?\n/.exec(raw);
  const head = split === null ? raw : raw.slice(0, split.index);
  const headers = new Map<string, string>();

  for (const line of Buffer.from(head, "latin1")
    .toString("utf8")
    .split(/\r?\n(?![ \t])/)) {
    const colon = line.indexOf(":");

    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      headers.set(
        name,
        headers.get(name) ??
          line
            .slice(colon + 1)
            .replaceAll(/\r?\n[ \t]+/g, " ")
            .trim(),
      );
    }
  }

  return { headers, body: split === null ? "" : raw.slice(split.index + split[0].length) };
};

const decodeText = (bytes: Buffer, charset: string): string => {
  try {
    return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
};

/** A header's `=?charset?B|Q?…?=` words, decoded (RFC 2047). */
const words = (value: string): string =>
  value
    .replaceAll(/(\?=)\s+(=\?)/g, "$1$2")
    .replaceAll(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, kind: string, text: string) =>
      decodeText(
        kind.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text
                .replaceAll("_", " ")
                .replaceAll(/=([0-9a-f]{2})/gi, (__, hex: string) => String.fromCharCode(parseInt(hex, 16))),
              "latin1",
            ),
        charset.replace(/\*.*$/, ""),
      ),
    );

const param = (header: string, name: string): string | null =>
  new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header)?.slice(1).find(Boolean) ??
  null;

const bytesOf = ({ headers, body }: Part): Buffer => {
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();

  return encoding === "base64"
    ? Buffer.from(body.replaceAll(/\s+/g, ""), "base64")
    : encoding === "quoted-printable"
      ? Buffer.from(
          body
            .replaceAll(/=\r?\n/g, "")
            .replaceAll(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
          "latin1",
        )
      : Buffer.from(body, "latin1");
};

const fromHtml = (html: string): string =>
  html
    .replaceAll(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
    .replaceAll(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replaceAll(/<[^>]*>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\s*\n\s*/g, "\n");

/** The readable text of a message: its first plain-text part, else its HTML as text. Attachments are skipped. */
const textOf = (message: Part): string | null => {
  const type = message.headers.get("content-type") ?? "text/plain";
  const media = type.split(";")[0]?.trim().toLowerCase() ?? "";
  const boundary = param(type, "boundary");

  if (media.startsWith("multipart/") && boundary !== null) {
    const line = `^--${boundary.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    const [inside = ""] = message.body.split(new RegExp(`${line}--`, "m"));
    const parts = inside
      .split(new RegExp(`${line}[ \\t]*\\r?$`, "m"))
      .slice(1)
      .map((chunk) => part(chunk.replace(/^\r?\n/, "")))
      .filter((p) => !/^attachment/i.test(p.headers.get("content-disposition") ?? ""));
    const plain = parts.find((p) => /^text\/plain/i.test(p.headers.get("content-type") ?? "text/plain"));

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

const addresses = (value: string | undefined): Array<string> =>
  (value ?? "").match(/[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+/g)?.map((a) => a.toLowerCase()) ?? [];

const messageId = (value: string | undefined): string | null => /<([^>\s]+)>/.exec(value ?? "")?.[1] ?? null;

/** The rows of one raw message: the email, its sent or received event, and what it replies to. */
const messageRows = (raw: Buffer, mailbox: string, me: ReadonlySet<string>): Array<Row> => {
  const message = part(raw.toString("latin1"));
  const header = (name: string) => {
    const value = message.headers.get(name);
    return value === undefined || value === "" ? null : words(value);
  };
  const from = header("from");
  const subject = header("subject");
  const date = header("date");
  const ts = iso(date?.replaceAll(/\([^)]*\)/g, "").trim());
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

/**
 * Your mail, from any provider that speaks IMAP: each message as it came (its first 256 KB), in a
 * folder per mailbox. The password is an app password in `~/.netrc`, never in this repo.
 */
export const mail = (options: MailOptions) => {
  const { host, user, tls = true } = options;
  const port = options.port ?? (tls ? 993 : 143);
  const me = new Set([user, ...(options.addresses ?? [])].map((a) => a.toLowerCase()));

  return defineSource({
    name: options.name ?? "mail",

    /** Takes the messages after the last UID it took from each mailbox, oldest first, for at most 20 minutes. */
    fetch: async ({ dir, state }) => {
      if (!tls && !["localhost", "127.0.0.1", "::1"].includes(host)) {
        throw new Error(`plain IMAP would send your password in the clear; use TLS for ${host}`);
      }

      const file = `${state}/progress.json`;
      const progress: Progress = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const stop = Date.now() + BUDGET_MS;
      const imap = await session(host, port, tls);

      try {
        await imap.command(`LOGIN ${quote(user)} ${quote(password(host, user))}`, "LOGIN");

        for (const mailbox of options.mailboxes ?? chosen(await imap.command('LIST "" "*"'))) {
          const folder = `${dir}/${encodeURIComponent(mailboxName(mailbox))}`;
          const opened = await imap.command(`EXAMINE ${quote(mailbox)}`);
          const validity =
            opened.map(({ text }) => /\[UIDVALIDITY (\d+)\]/i.exec(text)?.[1]).find(Boolean) ?? "";
          const held = progress[mailbox];
          const last = held?.validity === validity ? held.uid : 0;
          const uids = (await imap.command(`UID SEARCH UID ${last + 1}:*`))
            .flatMap(({ text }) => (text.startsWith("* SEARCH") ? text.split(" ").slice(2) : []))
            .map(Number)
            .filter((uid) => uid > last)
            .toSorted((a, b) => a - b);

          mkdirSync(folder);

          for (let i = 0; i < uids.length && Date.now() < stop; i += BATCH) {
            const batch = uids.slice(i, i + BATCH);

            for (const { text, literals } of await imap.command(
              `UID FETCH ${batch.join(",")} (UID BODY.PEEK[]<0.${KEEP}>)`,
            )) {
              const uid = /\bUID (\d+)/i.exec(text)?.[1];
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

    rows: function* ({ dir }) {
      for (const folder of readdirSync(dir).toSorted()) {
        const mailbox = decodeURIComponent(folder);

        for (const file of readdirSync(`${dir}/${folder}`)
          .filter((name) => name.endsWith(".eml"))
          .toSorted((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
          yield* messageRows(readFileSync(`${dir}/${folder}/${file}`), mailbox, me);
        }
      }
    },
  });
};
