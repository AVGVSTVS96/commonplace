import type { Row } from "./schema.ts";
import type { Source } from "./source.ts";

export interface Config {
  readonly sources: readonly Source[];
  readonly redact?: (row: Row, source: string) => boolean;
}

export const defineConfig = (config: Config): Config => config;
