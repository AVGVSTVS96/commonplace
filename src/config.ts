import type { Row } from "./schema.ts";
import type { Source } from "./source.ts";

export interface Config {
  /** Strongest first: when two sources disagree on a field, the earlier one wins. */
  readonly sources: ReadonlyArray<Source>;
  /** Sources an MCP client may read. `commonplace mcp --sources a,b` narrows it per client. */
  readonly mcp: ReadonlyArray<string>;
  /** Rows to keep out of the archive. Redacted rows never reach the database. */
  readonly redact?: (row: Row, source: string) => boolean;
}

export const defineConfig = (config: Config): Config => config;
