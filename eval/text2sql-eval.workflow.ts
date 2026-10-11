/* zcode-workflow
args:
  datasetDir:
    type: string
    default: "eval/sample"
    description: "评测数据集目录(相对 workspace),内含 questions.jsonl 与 gold.jsonl"
  limit:
    type: number
    default: 8
    description: "本次最多评测的题目数(上限 100)"
  toolPrefix:
    type: string
    default: "mcp__text2sql__"
    description: "text2sql MCP 工具前缀;评 Spider 数据集时传 mcp__text2sql-spider__"
*/

// text2sql 评测 workflow —— 在 ZCode 中运行(CreateWorkflow 选本文件,或保存后按名运行):
//   逐题把自然语言问题交给"求解"子代理生成 SQL,再由"评审"子代理把候选 SQL 与 gold SQL
//   都通过 text2sql MCP 的 run_sql 在目标库上执行并比较结果集,得到执行准确率。
//
// 求解/评审代理的纪律(写在 prompt 里,属软约束):只允许读文件 + 调用 text2sql MCP 工具。
//
// 运行前提:
//   1. .zcode/config.json 已注册 MCP server(默认 text2sql 指向样例库;Spider 用
//      text2sql-spider,通过 toolPrefix 参数切换工具前缀)。
//   2. schema 文档已导出并用 zg 建好索引(bun run src/cli.ts export / index)。
//   3. 数据集目录含 questions.jsonl 与 gold.jsonl(eval/sample 是自带样例)。
//
// 不传 args 时用下方常量。

interface Question {
  /** 题目 id */
  id: string;
  /** 目标数据库标签(MCP 工具的 db 参数) */
  db: string;
  /** 自然语言问题 */
  question: string;
  /** 可选:外部知识/提示(如 BIRD 的 evidence),只发给求解者 */
  evidence?: string;
}

interface Gold {
  /** 题目 id,与 questions.jsonl 对应 */
  id: string;
  /** 参考答案 SQL,只发给评审,不发给求解者 */
  gold_sql: string;
}

interface SolverResult {
  /** 最终 SQL:目标库上可执行的单条 SELECT/WITH 语句 */
  sql: string;
  /** 用到了哪些表,逗号分隔,便于报告 */
  tablesUsed: string;
}

interface JudgeResult {
  /** 两个 SQL 执行结果集是否等价 */
  correct: boolean;
  /** 一句话判定依据(行数/取值差异、报错信息等) */
  evidence: string;
}

interface Outcome {
  /** 题目 id */
  id: string;
  /** 自然语言问题 */
  question: string;
  /** 求解者给出的 SQL */
  sql: string;
  /** 参考答案 SQL */
  gold: string;
  /** 执行准确判定结果 */
  correct: boolean;
  /** 判定依据 */
  evidence: string;
  /** 求解者用到的表 */
  tablesUsed: string;
}

const TOOL_PREFIX =
  typeof args.toolPrefix === "string" && args.toolPrefix ? args.toolPrefix : "mcp__text2sql__";
const DATASET_DIR = "eval/sample";
const MAX_QUESTIONS = 8;

const SOLVER_SYSTEM =
  "你是一个 text2sql 求解器:把自然语言问题转成目标数据库上的单条 SQL。\n" +
  "工具纪律(必须严格遵守):\n" +
  "- 只允许使用文件读取工具(Read)和这些 MCP 工具:" +
  TOOL_PREFIX + "search_schema(检索表结构文档)、" +
  TOOL_PREFIX + "get_table_schema(看单表完整结构)、" +
  TOOL_PREFIX + "run_sql(执行只读 SQL)、" +
  TOOL_PREFIX + "list_databases、" +
  TOOL_PREFIX + "sample_rows。\n" +
  "- 禁止使用 Bash/命令行,禁止编辑文件,禁止联网,禁止使用其他任何工具。\n" +
  "- 若 MCP 工具不可用或连续失败,如实说明并返回尽力而为的 SQL,不要假装验证过。\n" +
  "解题流程:search_schema 定位相关表 → get_table_schema 看清楚列/外键 → 写 SQL → run_sql 实际执行验证并检查返回值是否合理 → 修正。";

const JUDGE_SYSTEM =
  "你是 SQL 执行评审员:给你候选 SQL 和参考 SQL,你要在目标数据库上实际执行两者并比较结果集。\n" +
  "工具纪律(必须严格遵守):只允许使用文件读取工具(Read)和 " + TOOL_PREFIX + "run_sql、" +
  TOOL_PREFIX + "list_databases 这两个 MCP 工具;禁止 Bash/命令行、编辑、联网。\n" +
  "判定标准:结果集等价即正确——行数相同且各行的取值(作为多重集合)一致;列名不同、列顺序不同、" +
  "整数与浮点表示差异(1 与 1.0)都不影响判定;若 ORDER BY 明确存在则考虑顺序。\n" +
  "任一 SQL 执行报错,或结果集不等价,都判 incorrect。如实判定,不要客气,也不要臆测。";

function parseJsonl(raw: string): Record<string, unknown>[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---- 读取数据集(普通脚本逻辑,不占阶段) ----
const datasetDir = typeof args.datasetDir === "string" && args.datasetDir ? args.datasetDir : DATASET_DIR;
const limit =
  typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : MAX_QUESTIONS;

const questions = parseJsonl(await files.read(`${datasetDir}/questions.jsonl`)) as unknown as Question[];
const golds = new Map<string, string>();
for (const g of parseJsonl(await files.read(`${datasetDir}/gold.jsonl`)) as unknown as Gold[]) {
  golds.set(g.id, g.gold_sql);
}
const pairs = questions.filter((q) => golds.has(q.id)).slice(0, limit);
log(`评测集 ${datasetDir}:共 ${questions.length} 题,本次评 ${pairs.length} 题(工具前缀 ${TOOL_PREFIX})`);

artifact.table("results", {
  title: "text2sql 评测逐题结果",
  key: "id",
  columns: [
    { field: "id", label: "题目" },
    { field: "correct", label: "正确" },
    { field: "tablesUsed", label: "用到的表" },
    { field: "evidence", label: "判定依据" },
  ],
});

phase("逐题求解 SQL 并执行判定");

const outcomes: Outcome[] = await Promise.all(
  pairs.map((q, i) =>
    (async (): Promise<Outcome> => {
      const gold = golds.get(q.id) ?? "";
      try {
        const solver = agent(`sql-solver-${q.id}`, { system: SOLVER_SYSTEM });
        const s = await solver.ask<SolverResult>(
          [
            `目标数据库:${q.db}(MCP 工具的 db 参数用这个标签)。`,
            `问题:${q.question}`,
            q.evidence ? `参考知识/提示:${q.evidence}` : "",
            "",
            "完成求解后按以下格式返回(严格 JSON,不要多余文字):",
            '{"sql": "<最终 SQL>", "tablesUsed": "<逗号分隔的表名>"}',
          ]
            .filter(Boolean)
            .join("\n"),
        );

        const judge = agent(`sql-judge-${q.id}`, { system: JUDGE_SYSTEM });
        const j = await judge.ask<JudgeResult>(
          [
            `目标数据库:${q.db}(MCP 工具的 db 参数用这个标签)。`,
            `问题:${q.question}`,
            "",
            `候选 SQL:\n${s.sql}`,
            "",
            `参考 SQL:\n${gold}`,
            "",
            "请把两条 SQL 都实际执行(run_sql),比较结果集,然后按以下格式返回(严格 JSON):",
            '{"correct": true/false, "evidence": "<一句话依据,含两侧行数/差异>"}',
          ].join("\n"),
        );

        const o: Outcome = {
          id: q.id,
          question: q.question,
          sql: s.sql,
          gold,
          correct: j.correct,
          evidence: j.evidence,
          tablesUsed: s.tablesUsed,
        };
        report(o, "results");
        return o;
      } catch (e) {
        const o: Outcome = {
          id: q.id,
          question: q.question,
          sql: "",
          gold,
          correct: false,
          evidence: `求解/评审失败: ${e instanceof Error ? e.message : String(e)}`,
          tablesUsed: "",
        };
        report(o, "results");
        return o;
      }
    })(),
  ),
);

// ---- 汇总与发布(普通脚本逻辑) ----
const correctCount = outcomes.filter((o) => o.correct).length;
const accuracy = outcomes.length > 0 ? correctCount / outcomes.length : 0;

const lines: string[] = [];
lines.push(`# text2sql 评测报告`);
lines.push("");
lines.push(`- 数据集:\`${datasetDir}\``);
lines.push(`- 本次评测:**${outcomes.length}** 题`);
lines.push(`- 执行准确率:**${(accuracy * 100).toFixed(1)}%**(${correctCount}/${outcomes.length})`);
lines.push(`- 工具约束:求解/评审代理仅允许读文件 + 调用 ${TOOL_PREFIX}*(prompt 级软约束)`);
lines.push("");
lines.push("| 题目 | 结果 | 求解 SQL | 判定依据 |");
lines.push("|---|---|---|---|");
for (const o of outcomes) {
  lines.push(`| ${o.id} | ${o.correct ? "✅" : "❌"} | \`${o.sql.replace(/\|/g, "\\|").slice(0, 120)}\` | ${o.evidence.replace(/\|/g, "\\|").slice(0, 120)} |`);
}
lines.push("");

await artifact.markdown("report", lines.join("\n"), {
  title: "text2sql 评测报告",
  description: `${outcomes.length} 题执行准确率 ${(accuracy * 100).toFixed(1)}%,逐题 SQL 与判定依据`,
  primary: true,
});

return {
  conclusion: `在 ${datasetDir} 上评测了 ${outcomes.length} 题,执行准确率 ${(accuracy * 100).toFixed(1)}%(${correctCount}/${outcomes.length})。`,
  accuracy,
  correctCount,
  total: outcomes.length,
  datasetDir,
  findings: outcomes.map((o) => ({
    where: o.id,
    what: o.correct ? "正确" : `错误:${o.evidence}`,
    evidence: `候选: ${o.sql || "(空)"} | 参考: ${o.gold}`,
    status: "verified" as const,
    severity: (o.correct ? "low" : "medium") as "low" | "medium",
  })),
  verified: [
    `每题的候选 SQL 与 gold SQL 均由评审子代理通过 ${TOOL_PREFIX}run_sql 在真实数据库上执行并比较结果集`,
    `求解/评审代理按 prompt 纪律只使用 Read + ${TOOL_PREFIX}* 工具(软约束,未做工具级硬限制)`,
  ],
  notCovered: [
    "未做 exact match 类型的 SQL 文本对比(只做执行结果集对比)",
    "未防御求解代理读取 gold.jsonl(prompt 未提供路径,但无硬性文件访问限制)",
  ],
};
