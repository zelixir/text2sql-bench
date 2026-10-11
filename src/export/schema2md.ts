import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseAdapter, TableInfo } from "../db/types";

export interface ExportOptions {
  /** Sample rows per table written into the docs (0 disables). */
  sampleRows: number;
  /** Compute and write per-table row counts (one COUNT(*) per table). */
  rowCounts: boolean;
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  s = s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

function mdTable(columns: string[], rows: unknown[][]): string {
  const head = `| ${columns.map(escapeCell).join(" | ")} |`;
  const sep = `|${columns.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`).join("\n");
  return [head, sep, body].filter((l) => l.length > 0).join("\n");
}

function renderTable(dbName: string, t: TableInfo, samples: unknown[][] | null, sampleColumns: string[]): string {
  const lines: string[] = [];
  lines.push(`# Table \`${t.name}\` (database \`${dbName}\`, ${t.kind})`);
  lines.push("");
  if (t.rowCount !== null) lines.push(`Row count: ${t.rowCount}`);
  lines.push("");
  lines.push("## Columns");
  lines.push("");
  lines.push(mdTable(
    ["column", "type", "not null", "default", "primary key"],
    t.columns.map((c) => [c.name, c.type, c.notNull ? "YES" : "NO", c.defaultValue ?? "", c.isPrimaryKey ? "YES" : "NO"]),
  ));
  lines.push("");
  lines.push("## Foreign keys");
  lines.push("");
  if (t.foreignKeys.length === 0) {
    lines.push("None.");
  } else {
    for (const f of t.foreignKeys) {
      lines.push(`- \`${f.column}\` → \`${f.refTable}.${f.refColumn}\``);
    }
  }
  if (samples && samples.length > 0) {
    lines.push("");
    lines.push(`## Sample rows (first ${samples.length})`);
    lines.push("");
    lines.push(mdTable(sampleColumns, samples));
  }
  if (t.ddl) {
    lines.push("");
    lines.push("## DDL");
    lines.push("");
    lines.push("```sql");
    lines.push(t.ddl.trim());
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

function renderOverview(dbName: string, spec: string, tables: TableInfo[]): string {
  const lines: string[] = [];
  lines.push(`# Database \`${dbName}\` schema overview`);
  lines.push("");
  lines.push(`Source: \`${spec}\``);
  const realTables = tables.filter((t) => t.kind === "table");
  const views = tables.filter((t) => t.kind === "view");
  lines.push(`Tables: ${realTables.length}, views: ${views.length}`);
  lines.push("");
  lines.push("## All tables");
  lines.push("");
  lines.push(mdTable(
    ["table", "kind", "rows", "columns"],
    tables.map((t) => [
      t.name,
      t.kind,
      t.rowCount ?? "?",
      t.columns.map((c) => c.name).join(", "),
    ]),
  ));
  const fks = tables.flatMap((t) => t.foreignKeys.map((f) => ({ from: t.name, ...f })));
  if (fks.length > 0) {
    lines.push("");
    lines.push("## Relationships");
    lines.push("");
    for (const f of fks) {
      lines.push(`- \`${f.from}.${f.column}\` → \`${f.refTable}.${f.refColumn}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export interface ExportSummary {
  dbName: string;
  dir: string;
  tables: number;
  files: string[];
}

/** Dump one database's schema (plus samples) as markdown into `<outDir>/<dbName>/`. */
export async function exportDatabase(
  adapter: DatabaseAdapter,
  outDir: string,
  opts: ExportOptions,
): Promise<ExportSummary> {
  const dbDir = join(outDir, safeFileName(adapter.name));
  const tablesDir = join(dbDir, "tables");
  await mkdir(tablesDir, { recursive: true });

  const entries = await adapter.listTables();
  const infos: TableInfo[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    const info = await adapter.tableInfo(entry.name);
    infos.push(info);

    let samples: unknown[][] | null = null;
    let sampleColumns: string[] = [];
    if (opts.sampleRows > 0 && info.columns.length > 0) {
      try {
        const res = await adapter.runSelect(
          `SELECT * FROM ${quoteSqliteSafe(entry.name)} LIMIT ${Math.floor(opts.sampleRows)}`,
        );
        samples = res.rows.map((r) => res.columns.map((c) => r[c]));
        sampleColumns = res.columns;
      } catch {
        samples = null;
      }
    }

    const file = join(tablesDir, `${safeFileName(entry.name)}.md`);
    await writeFile(file, renderTable(adapter.name, info, samples, sampleColumns), "utf8");
    files.push(file);
  }

  const overview = join(dbDir, "overview.md");
  await writeFile(overview, renderOverview(adapter.name, adapter.spec, infos), "utf8");
  files.unshift(overview);

  return { dbName: adapter.name, dir: dbDir, tables: infos.length, files };
}

function quoteSqliteSafe(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
