import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { MySqlAdapter } from "./mysql";
import { PostgresAdapter } from "./postgres";
import { defaultSqliteName, SqliteAdapter } from "./sqlite";
import type { DatabaseAdapter } from "./types";

export * from "./types";

/** Default database label for a connection spec (used for docs dirs and MCP `db` args). */
export function defaultDbName(spec: string): string {
  if (/^(mysql|mariadb):\/\//.test(spec)) {
    return decodeURIComponent(new URL(spec).pathname.replace(/^\//, "")) || "mysql";
  }
  if (/^(postgres|postgresql):\/\//.test(spec)) {
    return decodeURIComponent(new URL(spec).pathname.replace(/^\//, "")) || "postgres";
  }
  return defaultSqliteName(spec);
}

export function openDatabase(spec: string, name?: string): DatabaseAdapter {
  if (/^(mysql|mariadb):\/\//.test(spec)) return new MySqlAdapter(spec, name);
  if (/^(postgres|postgresql):\/\//.test(spec)) return new PostgresAdapter(spec, name);
  return new SqliteAdapter(spec, name);
}

/** Every sqlite file directly inside `dir`, mapped to its default label. */
export function sqliteFilesInDir(dir: string): { spec: string; name: string }[] {
  const exts = new Set([".db", ".sqlite", ".sqlite3"]);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && exts.has(extname(e.name).toLowerCase()))
    .map((e) => ({ spec: join(dir, e.name), name: defaultSqliteName(e.name) }));
}

export interface DbSpecInput {
  spec: string;
  name?: string;
}

/** Resolve `--db` / `--db-dir` inputs into a labeled spec list (later entries win on label clash). */
export function resolveDbSpecs(dbs: DbSpecInput[], dbDirs: string[]): DbSpecInput[] {
  const byName = new Map<string, DbSpecInput>();
  for (const dir of dbDirs) {
    for (const entry of sqliteFilesInDir(dir)) byName.set(entry.name, entry);
  }
  for (const db of dbs) byName.set(db.name ?? defaultDbName(db.spec), db);
  return [...byName.values()];
}
