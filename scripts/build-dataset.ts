/**
 * Convert a downloaded text2sql benchmark into this repo's eval format:
 *   <out>/questions.jsonl  {id, db, question, evidence?}
 *   <out>/gold.jsonl       {id, gold_sql}
 *
 * Supported formats:
 *   spider: dev.json (array of {db_id, question, query})
 *   bird:   *.json   (array of {question_id, db_id, question, SQL, evidence})
 *
 * Usage:
 *   bun run scripts/build-dataset.ts --format spider --dev <path/to/dev.json> --out eval/datasets/spider
 *   bun run scripts/build-dataset.ts --format bird   --dev <path/to/mini_dev.json> --out eval/datasets/bird
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const format = arg("format") ?? "spider";
const devPath = arg("dev");
const outDir = arg("out");
if (!devPath || !outDir) {
  console.error("usage: build-dataset.ts --format spider|bird --dev <dev.json> --out <dir>");
  process.exit(2);
}

interface Raw {
  [k: string]: unknown;
}

const raw = JSON.parse(readFileSync(devPath, "utf8")) as Raw[];
if (!Array.isArray(raw)) {
  console.error(`${devPath} is not a JSON array`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const questions: string[] = [];
const gold: string[] = [];

raw.forEach((item, i) => {
  const db = String(item.db_id ?? item.db ?? "");
  const question = String(item.question ?? "");
  const sql = String(item.SQL ?? item.query ?? "");
  const evidence = item.evidence !== undefined ? String(item.evidence) : undefined;
  const id = format === "bird" ? String(item.question_id ?? `bird-${i}`) : `${format}-dev-${i}`;
  if (!db || !question || !sql) return;
  questions.push(JSON.stringify(evidence !== undefined ? { id, db, question, evidence } : { id, db, question }));
  gold.push(JSON.stringify({ id, gold_sql: sql }));
});

writeFileSync(join(outDir, "questions.jsonl"), questions.join("\n") + "\n", "utf8");
writeFileSync(join(outDir, "gold.jsonl"), gold.join("\n") + "\n", "utf8");
console.log(`wrote ${questions.length} questions → ${join(outDir, "questions.jsonl")}`);
if (!existsSync(join(outDir, "README.md"))) {
  writeFileSync(
    join(outDir, "README.md"),
    `# ${format} eval dataset\n\nConverted from \`${devPath}\`.\n` +
      `Point the MCP server at the benchmark's sqlite database directory and search docs at that directory's export output.\n`,
    "utf8",
  );
}
