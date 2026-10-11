export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

export interface ForeignKeyInfo {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface TableEntry {
  name: string;
  kind: "table" | "view";
}

export interface TableInfo {
  name: string;
  kind: "table" | "view";
  rowCount: number | null;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** CREATE TABLE statement when the engine exposes one; otherwise a reconstruction. */
  ddl: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface DatabaseAdapter {
  /** Label used for docs directories, MCP `db` arguments and file names. */
  readonly name: string;
  /** Original connection spec (url or file path). */
  readonly spec: string;
  listTables(): Promise<TableEntry[]>;
  tableInfo(name: string): Promise<TableInfo>;
  runSelect(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

const READ_ONLY_SQL = /^(select|with)\b/i;

/**
 * Enforce a single read-only statement and return it without the trailing
 * semicolon. This is a type-level guard (defense in depth); prefer connecting
 * with read-only credentials / read-only file handles where the engine allows.
 */
export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed (no `;` inside)");
  }
  if (!READ_ONLY_SQL.test(trimmed)) {
    throw new Error("Only SELECT / WITH queries are allowed");
  }
  return trimmed;
}

/** Quote an identifier for engines that use double quotes (SQLite / Postgres). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
