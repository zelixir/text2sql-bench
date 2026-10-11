import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultDbName, openDatabase, type DbSpecInput } from "../db";
import type { DatabaseAdapter } from "../db/types";
import { safeFileName } from "../export/schema2md";
import { zgSearch } from "../zg";

export interface McpServerOptions {
  /** Directory containing `<db>/overview.md` and `<db>/tables/*.md`. */
  docsDir: string;
  /** Database connection specs, each with an optional explicit label. */
  dbs: DbSpecInput[];
  /** Max rows returned by run_sql before truncation (default 50). */
  maxRows?: number;
}

type TextContent = { type: "text"; text: string };

function text(t: string, isError = false): { content: TextContent[]; isError?: boolean } {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const maxRows = opts.maxRows ?? 50;

  // labeled specs; explicit names win, otherwise derived from the spec
  const specs = new Map<string, DbSpecInput>();
  for (const db of opts.dbs) specs.set(db.name ?? defaultDbName(db.spec), db);

  const adapters = new Map<string, DatabaseAdapter>();
  async function getAdapter(label: string): Promise<DatabaseAdapter> {
    const key = specs.has(label) ? label : [...specs.keys()].find((k) => k.toLowerCase() === label.toLowerCase()) ?? "";
    if (!key) {
      throw new Error(`Unknown database ${label}. Available: ${[...specs.keys()].join(", ")}`);
    }
    let a = adapters.get(key);
    if (!a) {
      const spec = specs.get(key)!;
      a = openDatabase(spec.spec, spec.name);
      adapters.set(key, a);
    }
    return a;
  }

  const server = new McpServer({ name: "text2sql", version: "0.1.0" });

  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description: "List every database this server is connected to (labels usable as the `db` argument of other tools).",
      inputSchema: {},
    },
    async () => text([...specs.entries()].map(([name, s]) => `${name}: ${s.spec}`).join("\n")),
  );

  server.registerTool(
    "search_schema",
    {
      title: "Search schema docs",
      description:
        "Hybrid semantic + keyword search over indexed schema markdown docs of the target databases. " +
        "Use it to find which tables/columns are relevant to a question. Returns ranked hits with file paths " +
        "(paths contain the database and table name).",
      inputSchema: {
        query: z.string().describe("Natural language question or keywords, e.g. 'tracks belonging to an album'"),
        limit: z.number().int().positive().max(30).optional().describe("Max hits per search group (default 8)"),
      },
    },
    async ({ query, limit }) => text(await zgSearch(opts.docsDir, query, limit ?? 8)),
  );

  server.registerTool(
    "get_table_schema",
    {
      title: "Get table schema",
      description:
        "Read the full markdown schema doc of one table: columns, types, foreign keys, sample rows and DDL.",
      inputSchema: {
        db: z.string().describe("Database label (see list_databases)"),
        table: z.string().describe("Table name"),
      },
    },
    async ({ db, table }) => {
      const file = join(opts.docsDir, safeFileName(db), "tables", `${safeFileName(table)}.md`);
      const f = Bun.file(file);
      if (await f.exists()) return text(await f.text());
      const dir = join(opts.docsDir, safeFileName(db), "tables");
      let available = "";
      try {
        available = (await readdir(dir)).map((n) => n.replace(/\.md$/, "")).join(", ");
      } catch {
        available = `<docs not found under ${dir}>`;
      }
      return text(`No schema doc for table ${table} in database ${db}. Available tables: ${available}`, true);
    },
  );

  server.registerTool(
    "run_sql",
    {
      title: "Run SQL (read-only)",
      description:
        "Execute a single read-only query (SELECT or WITH) against one of the connected databases and get the result rows as JSON. " +
        "Results are truncated to the row cap when larger.",
      inputSchema: {
        sql: z.string().describe("A single SELECT/WITH statement; no semicolons"),
        db: z.string().optional().describe("Database label; optional when exactly one database is connected"),
      },
    },
    async ({ sql, db }) => {
      try {
        const label = db ?? (specs.size === 1 ? [...specs.keys()][0] : "");
        if (!label) {
          return text(`Multiple databases are connected; pass \`db\`. Available: ${[...specs.keys()].join(", ")}`, true);
        }
        const adapter = await getAdapter(label);
        const res = await adapter.runSelect(sql);
        const truncated = res.rows.length > maxRows;
        const body = {
          db: adapter.name,
          rowCount: res.rows.length,
          truncated,
          columns: res.columns,
          rows: truncated ? res.rows.slice(0, maxRows) : res.rows,
        };
        return text(JSON.stringify(body));
      } catch (e) {
        return text(`SQL error: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  server.registerTool(
    "sample_rows",
    {
      title: "Sample rows",
      description: "Peek at the first N rows of a table (read-only).",
      inputSchema: {
        db: z.string().describe("Database label"),
        table: z.string().describe("Table name"),
        limit: z.number().int().positive().max(100).optional().describe("Row count (default 5)"),
      },
    },
    async ({ db, table, limit }) => {
      try {
        const adapter = await getAdapter(db);
        const quoted = `"${table.replace(/"/g, '""')}"`;
        const res = await adapter.runSelect(`SELECT * FROM ${quoted} LIMIT ${limit ?? 5}`);
        return text(JSON.stringify({ db: adapter.name, table, rowCount: res.rows.length, columns: res.columns, rows: res.rows }));
      } catch (e) {
        return text(`sample_rows error: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`text2sql MCP ready: dbs=[${[...specs.keys()].join(", ")}] docs=${opts.docsDir}`);
  // stdio server runs until the client closes the pipe or the process is killed
  await new Promise<never>(() => {});
}
