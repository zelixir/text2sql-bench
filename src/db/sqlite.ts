import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  assertReadOnly,
  quoteIdent,
  type DatabaseAdapter,
  type QueryResult,
  type TableEntry,
  type TableInfo,
} from "./types";

interface PragmaColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface PragmaFkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}

export function sqliteFileFromSpec(spec: string): string {
  return spec.startsWith("sqlite://") ? spec.slice("sqlite://".length) : spec;
}

export function defaultSqliteName(spec: string): string {
  const file = sqliteFileFromSpec(spec);
  return basename(file, extname(file)) || "sqlite";
}

export class SqliteAdapter implements DatabaseAdapter {
  readonly name: string;
  readonly spec: string;
  private db: Database;

  constructor(spec: string, name?: string) {
    const file = sqliteFileFromSpec(spec);
    if (!existsSync(file)) {
      throw new Error(`SQLite file not found: ${file}`);
    }
    this.db = new Database(file, { readonly: true });
    this.name = name ?? defaultSqliteName(spec);
    this.spec = spec;
  }

  async listTables(): Promise<TableEntry[]> {
    const rows = this.db
      .query<{ name: string; type: string }, []>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    return rows.map((r) => ({ name: r.name, kind: r.type === "view" ? "view" : "table" }));
  }

  async tableInfo(name: string): Promise<TableInfo> {
    const columns = this.db
      .query<PragmaColumnRow, []>(`PRAGMA table_info(${quoteIdent(name)})`)
      .all()
      .map((c) => ({
        name: c.name,
        type: c.type || "ANY",
        notNull: c.notnull === 1,
        defaultValue: c.dflt_value,
        isPrimaryKey: c.pk > 0,
      }));
    const fks = this.db
      .query<PragmaFkRow, []>(`PRAGMA foreign_key_list(${quoteIdent(name)})`)
      .all()
      .map((f) => ({ column: f.from, refTable: f.table, refColumn: f.to ?? f.from }));
    const ddl = this.db
      .query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name)?.sql ?? null;
    let rowCount: number | null = null;
    try {
      rowCount =
        this.db
          .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)
          .get()?.n ?? null;
    } catch {
      // virtual tables etc. — leave null
    }
    return {
      name,
      kind: columns.length > 0 || ddl !== null ? "table" : "table",
      rowCount,
      columns,
      foreignKeys: fks,
      ddl,
    };
  }

  async runSelect(sql: string): Promise<QueryResult> {
    const q = assertReadOnly(sql);
    const rows = this.db.query(q).all() as Record<string, unknown>[];
    // bun:sqlite Statement has no column metadata API; derive from the first row
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { columns, rows };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
