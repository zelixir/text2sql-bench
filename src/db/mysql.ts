import mysql from "mysql2/promise";
import {
  assertReadOnly,
  type DatabaseAdapter,
  type QueryResult,
  type TableEntry,
  type TableInfo,
} from "./types";

interface MysqlColumnRow {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
}

interface MysqlFkRow {
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

function dbFromUrl(spec: string): string {
  const url = new URL(spec);
  const db = url.pathname.replace(/^\//, "");
  if (!db) throw new Error(`MySQL URL must contain a database: ${spec}`);
  return db;
}

export class MySqlAdapter implements DatabaseAdapter {
  readonly name: string;
  readonly spec: string;
  private conn: mysql.Connection | null = null;
  private readonly schema: string;

  constructor(spec: string, name?: string) {
    this.spec = spec;
    this.schema = dbFromUrl(spec);
    this.name = name ?? this.schema;
  }

  private async c(): Promise<mysql.Connection> {
    this.conn ??= await mysql.createConnection(this.spec);
    return this.conn;
  }

  async listTables(): Promise<TableEntry[]> {
    const c = await this.c();
    const [rows] = await c.query<mysql.RowDataPacket[]>(
      "SELECT TABLE_NAME AS name, TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [this.schema],
    );
    return rows.map((r) => ({
      name: String(r.name),
      kind: r.t === "VIEW" ? "view" : "table",
    }));
  }

  async tableInfo(name: string): Promise<TableInfo> {
    const c = await this.c();
    const [colRows] = await c.query<MysqlColumnRow[] & mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [this.schema, name],
    );
    const [fkRows] = await c.query<MysqlFkRow[] & mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY ORDINAL_POSITION",
      [this.schema, name],
    );
    const [ddlRows] = await c.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE \`${name.replace(/`/g, "``")}\``);
    const ddl = (ddlRows[0] as Record<string, string | undefined> | undefined)?.["Create Table"] ?? null;

    let rowCount: number | null = null;
    try {
      const [cnt] = await c.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${name.replace(/`/g, "``")}\``);
      rowCount = Number((cnt[0] as Record<string, unknown>)?.n ?? 0);
    } catch {
      // leave null
    }

    return {
      name,
      kind: ddl !== null ? "table" : "table",
      rowCount,
      columns: colRows.map((r) => ({
        name: r.COLUMN_NAME,
        type: r.COLUMN_TYPE,
        notNull: r.IS_NULLABLE === "NO",
        defaultValue: r.COLUMN_DEFAULT,
        isPrimaryKey: r.COLUMN_KEY === "PRI",
      })),
      foreignKeys: fkRows.map((r) => ({
        column: r.COLUMN_NAME,
        refTable: r.REFERENCED_TABLE_NAME,
        refColumn: r.REFERENCED_COLUMN_NAME,
      })),
      ddl,
    };
  }

  async runSelect(sql: string): Promise<QueryResult> {
    const c = await this.c();
    const q = assertReadOnly(sql);
    const [rows, fields] = await c.query(q);
    return {
      columns: fields.map((f) => f.name),
      rows: rows as Record<string, unknown>[],
    };
  }

  async close(): Promise<void> {
    await this.conn?.end();
  }
}
