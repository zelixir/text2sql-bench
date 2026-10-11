import pg from "pg";
import {
  assertReadOnly,
  quoteIdent,
  type ColumnInfo,
  type DatabaseAdapter,
  type ForeignKeyInfo,
  type QueryResult,
  type TableEntry,
  type TableInfo,
} from "./types";

function dbFromUrl(spec: string): string {
  const url = new URL(spec);
  const db = url.pathname.replace(/^\//, "");
  if (!db) throw new Error(`Postgres URL must contain a database: ${spec}`);
  return db;
}

function reconstructionDdl(name: string, columns: ColumnInfo[], fks: ForeignKeyInfo[]): string {
  const lines = columns.map((c) => {
    let line = `  ${quoteIdent(c.name)} ${c.type}`;
    if (c.notNull) line += " NOT NULL";
    if (c.defaultValue !== null) line += ` DEFAULT ${c.defaultValue}`;
    if (c.isPrimaryKey) line += " /* PRIMARY KEY */";
    return line;
  });
  for (const f of fks) {
    lines.push(`  /* FOREIGN KEY (${quoteIdent(f.column)}) REFERENCES ${quoteIdent(f.refTable)}(${quoteIdent(f.refColumn)}) */`);
  }
  return `CREATE TABLE ${quoteIdent(name)} (\n${lines.join(",\n")}\n);`;
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly name: string;
  readonly spec: string;
  private client: pg.Client | null = null;
  private readonly schema: string;

  constructor(spec: string, name?: string) {
    this.spec = spec;
    this.schema = new URL(spec).searchParams.get("schema") ?? "public";
    this.name = name ?? dbFromUrl(spec);
  }

  private async c(): Promise<pg.Client> {
    this.client ??= new pg.Client({ connectionString: this.spec });
    if (!this.client) throw new Error("failed to open postgres client");
    await this.client.connect();
    return this.client;
  }

  async listTables(): Promise<TableEntry[]> {
    const c = await this.c();
    const res = await c.query<{
      name: string;
      kind: string;
    }>(
      "SELECT table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [this.schema],
    );
    return res.rows.map((r) => ({ name: r.name, kind: r.kind === "VIEW" ? "view" : "table" }));
  }

  async tableInfo(name: string): Promise<TableInfo> {
    const c = await this.c();
    const colRes = await c.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [this.schema, name],
    );
    const pkRes = await c.query<{ attname: string }>(
      `SELECT a.attname FROM pg_index i
       JOIN pg_class cl ON cl.oid = i.indrel
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = ANY(i.indkey)
       WHERE i.indisprimary AND n.nspname = $1 AND cl.relname = $2`,
      [this.schema, name],
    );
    const pks = new Set(pkRes.rows.map((r) => r.attname));
    const fkRes = await c.query<{ column_name: string; ref_table: string; ref_column: string }>(
      `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [this.schema, name],
    );

    const columns: ColumnInfo[] = colRes.rows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      notNull: r.is_nullable === "NO",
      defaultValue: r.column_default,
      isPrimaryKey: pks.has(r.column_name),
    }));
    const foreignKeys: ForeignKeyInfo[] = fkRes.rows.map((r) => ({
      column: r.column_name,
      refTable: r.ref_table,
      refColumn: r.ref_column,
    }));

    let rowCount: number | null = null;
    try {
      const cnt = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ${quoteIdent(this.schema)}.${quoteIdent(name)}`,
      );
      rowCount = Number(cnt.rows[0]?.n ?? 0);
    } catch {
      // leave null
    }

    return {
      name,
      kind: "table",
      rowCount,
      columns,
      foreignKeys,
      ddl: reconstructionDdl(name, columns, foreignKeys),
    };
  }

  async runSelect(sql: string): Promise<QueryResult> {
    const c = await this.c();
    const q = assertReadOnly(sql);
    const res = await c.query(q);
    return {
      columns: res.fields.map((f) => f.name),
      rows: res.rows as Record<string, unknown>[],
    };
  }

  async close(): Promise<void> {
    await this.client?.end();
  }
}
