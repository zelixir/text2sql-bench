/**
 * Smoke-test the MCP stdio server without ZCode: speak JSON-RPC over stdio and
 * exercise initialize / tools/list / tools/call (run_sql + search_schema).
 *
 * Usage: bun run scripts/mcp-smoke.ts [-- docs <docsDir> --db <sqlitePath>]
 */
import { join } from "node:path";

const docsDir = arg("docs") ?? join(import.meta.dir, "..", "docs");
const dbPath = arg("db") ?? join(import.meta.dir, "..", "eval", "sample", "demo.db");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const proc = Bun.spawn({
  cmd: ["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), "mcp", "--docs", docsDir, "--db", dbPath],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
let buffer = "";

async function rpc(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin.write(msg + "\n");
  await proc.stdin.flush();
  return new Promise((resolve) => pending.set(id, resolve));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = (await rpc("tools/call", { name, arguments: args })) as {
    result?: { content?: { text?: string }[] };
  };
  return res.result?.content?.[0]?.text;
}

const reader = (async () => {
  for await (const chunk of proc.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown };
        if (typeof msg.id === "number") {
          pending.get(msg.id)?.(msg.result);
          pending.delete(msg.id);
        }
      } catch {
        // not JSON — ignore
      }
    }
  }
})();

await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "mcp-smoke", version: "0.0.1" },
});
await rpc("notifications/initialized", {});

const tools = (await rpc("tools/list", {})) as { tools?: { name: string }[] };
console.log("TOOLS:", tools.tools?.map((t) => t.name).join(", "));

console.log("\n--- run_sql: SELECT COUNT(*) FROM customers ---");
console.log(await callTool("run_sql", { sql: "SELECT COUNT(*) AS n FROM customers", db: "demo" }));

console.log("\n--- run_sql: rejected UPDATE ---");
console.log(await callTool("run_sql", { sql: "UPDATE customers SET name = 'x'", db: "demo" }));

console.log("\n--- get_table_schema: products ---");
const schema = (await callTool("get_table_schema", { db: "demo", table: "products" })) as string;
console.log(schema.split("\n").slice(0, 12).join("\n") + "\n...");

console.log("\n--- search_schema: 'total revenue per order' ---");
console.log(await callTool("search_schema", { query: "total revenue of orders", limit: 3 }));

proc.stdin.end();
await reader;
await proc.exited;
console.log("\nsmoke test done");
