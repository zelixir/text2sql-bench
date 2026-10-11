#!/usr/bin/env bun
/**
 * t2s-bench — text2sql evaluation toolkit CLI.
 *
 *   export   dump database schema(s) to markdown docs
 *   index    build the zg (zvec-grep) index over a docs directory
 *   search   run a zg query against a docs directory (debugging)
 *   sql      run one read-only query against a database (debugging)
 *   mcp      start the stdio MCP server (search_schema / get_table_schema / run_sql / ...)
 */
import { defaultDbName, openDatabase, resolveDbSpecs, type DbSpecInput } from "./db";
import { exportDatabase } from "./export/schema2md";
import { startMcpServer } from "./mcp/server";
import { runZg, zgSearch } from "./zg";

function usage(): string {
  return `t2s-bench — text2sql evaluation toolkit

Usage: bun run src/cli.ts <command> [options]

Commands:
  export   Dump database schema(s) to markdown docs.
           --db <spec>            database spec, repeatable (file path for sqlite,
                                  mysql://user:pass@host/db, postgres://user:pass@host/db)
           --db-dir <dir>         register every *.db/*.sqlite[3] in the directory, repeatable
           --name <label>         explicit label for the last --db (repeatable, order-aligned)
           --out <dir>            output docs directory (default: docs)
           --sample-rows <n>      sample rows per table (default 3, 0 to disable)
           --no-rowcounts         skip COUNT(*) per table

  index    Build the zg index over a docs directory.  --docs <dir>
  search   Run a zg query over a docs directory.      --docs <dir> [--limit n] <query...>
  sql      Run one read-only query for debugging.      --db <spec> [--name label] <sql...>
  mcp      Start the stdio MCP server.                 --docs <dir> (--db <spec> | --db-dir <dir>)+
                                                     [--name label] [--max-rows n]

Database specs: a path to a *.db/*.sqlite file, sqlite://<path>, mysql://user:pass@host/db,
postgres://user:pass@host/db[?schema=public].
`;
}

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const push = (k: string, v: string) => {
    const arr = flags.get(k) ?? [];
    arr.push(v);
    flags.set(k, arr);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        push(key.slice(0, eq), key.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        push(key, argv[++i]!);
      } else {
        push(key, "true");
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

/** Pair each `--db` with the following `--name` occurrences in CLI order. */
function namedDbs(parsed: Parsed): DbSpecInput[] {
  const dbs = parsed.flags.get("db") ?? [];
  const names = parsed.flags.get("name") ?? [];
  return dbs.map((spec, i) => ({ spec, name: names[i] }));
}

function num(parsed: Parsed, key: string, dflt: number): number {
  const v = parsed.flags.get(key)?.[0];
  if (v === undefined) return dflt;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`--${key} expects a number, got ${v}`);
  return n;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  const parsed = parseArgs(rest);

  switch (command) {
    case "export": {
      const out = parsed.flags.get("out")?.[0] ?? "docs";
      const dbs = namedDbs(parsed);
      const dbDirs = parsed.flags.get("db-dir") ?? [];
      if (dbs.length === 0 && dbDirs.length === 0) {
        process.stderr.write("export: pass at least one --db or --db-dir\n");
        return 2;
      }
      const specs = resolveDbSpecs(dbs, dbDirs);
      const opts = {
        sampleRows: num(parsed, "sample-rows", 3),
        rowCounts: !parsed.flags.has("no-rowcounts"),
      };
      for (const spec of specs) {
        const adapter = openDatabase(spec.spec, spec.name);
        try {
          const summary = await exportDatabase(adapter, out, opts);
          process.stdout.write(`exported ${summary.tables} tables of \`${summary.dbName}\` → ${summary.dir}\n`);
        } finally {
          await adapter.close();
        }
      }
      process.stdout.write(`next: bun run src/cli.ts index --docs ${out}\n`);
      return 0;
    }

    case "index": {
      const docs = parsed.flags.get("docs")?.[0];
      if (!docs) {
        process.stderr.write("index: --docs <dir> is required\n");
        return 2;
      }
      const r = await runZg(["index"], docs);
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      if (!r.ok) {
        process.stderr.write(`zg index failed (exit ${r.exitCode})\n`);
        return r.exitCode || 1;
      }
      process.stdout.write(`index built for ${docs}\n`);
      return 0;
    }

    case "search": {
      const docs = parsed.flags.get("docs")?.[0];
      if (!docs || parsed.positionals.length === 0) {
        process.stderr.write("search: --docs <dir> and a query are required\n");
        return 2;
      }
      const query = parsed.positionals.join(" ");
      const limit = num(parsed, "limit", 8);
      process.stdout.write(await zgSearch(docs, query, limit));
      return 0;
    }

    case "sql": {
      const dbSpecs = namedDbs(parsed);
      if (dbSpecs.length === 0 || parsed.positionals.length === 0) {
        process.stderr.write("sql: --db <spec> and a query are required\n");
        return 2;
      }
      const adapter = openDatabase(dbSpecs[0]!.spec, dbSpecs[0]!.name);
      try {
        const res = await adapter.runSelect(parsed.positionals.join(" "));
        process.stdout.write(JSON.stringify({ rowCount: res.rows.length, columns: res.columns, rows: res.rows }, null, 2));
        process.stdout.write("\n");
      } finally {
        await adapter.close();
      }
      return 0;
    }

    case "mcp": {
      const docs = parsed.flags.get("docs")?.[0];
      if (!docs) {
        process.stderr.write("mcp: --docs <dir> is required\n");
        return 2;
      }
      const specs = resolveDbSpecs(namedDbs(parsed), parsed.flags.get("db-dir") ?? []);
      if (specs.length === 0) {
        process.stderr.write("mcp: pass at least one --db or --db-dir\n");
        return 2;
      }
      await startMcpServer({ docsDir: docs, dbs: specs, maxRows: num(parsed, "max-rows", 50) });
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${usage()}`);
      return 2;
  }
}

process.exit(await main());
