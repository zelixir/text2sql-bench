# text2sql-bench

通用的 text2sql 评测工具箱(Bun + TypeScript):

1. **schema → markdown**:把目标数据库(SQLite / MySQL / PostgreSQL)的结构导出成适合检索的 markdown 文档(逐表:列/类型/主外键/样本行/DDL;每库一份总览+关系摘要)。
2. **zg 索引**:用 [zvec-grep(`zg`)](https://zvec.org/zh/docs/zvec-grep/) 对文档做语义+关键词混合索引。
3. **stdio MCP server**:暴露 `search_schema`(zg 检索)、`get_table_schema`(单表全文)、`run_sql`(只读执行)、`sample_rows`、`list_databases` 五个工具,供评测 agent 使用。
4. **评测 workflow**:一个 ZCode dynamic workflow(`eval/text2sql-eval.workflow.ts`),逐题把自然语言问题交给求解子代理生成 SQL,再由评审子代理把候选 SQL 与 gold SQL 都经 MCP `run_sql` 真实执行、比较结果集,得到执行准确率(execution accuracy)。

## 安装

```bash
bun install
```

依赖本机已安装 `zg`(索引与检索),可用 `T2S_ZG_BIN` 指定其他路径。

## 快速开始(自带样例)

```bash
bun run demo            # 生成 eval/sample/demo.db(确定性样例库)
bun run src/cli.ts export --db eval/sample/demo.db --out docs   # schema → docs/demo/*.md
bun run src/cli.ts index  --docs docs                            # zg 建索引
bun run src/cli.ts search --docs docs "orders and their line items"   # 检索试一下
bun run scripts/mcp-smoke.ts     # 不依赖 ZCode 的 MCP 冒烟测试(JSON-RPC over stdio)
```

## CLI

```
bun run src/cli.ts <command> [options]

export  schema → markdown
        --db <spec>       可重复:文件路径(sqlite)/ mysql://user:pass@host/db / postgres://user:pass@host/db?schema=public
        --db-dir <dir>    可重复:批量注册目录下所有 *.db/*.sqlite[3]
        --name <label>    与 --db 按顺序配对的显式标签(默认取文件名/库名)
        --out <dir>       输出目录(默认 docs)
        --sample-rows <n> 每表样本行数(默认 3;0 关闭)
        --no-rowcounts    跳过 COUNT(*)

index   --docs <dir>          对文档目录建 zg 索引
search  --docs <dir> <query>  直接跑一次 zg 检索(调试)
sql     --db <spec> <sql>     对库跑一条只读 SQL(调试)
mcp     --docs <dir> (--db | --db-dir)+ [--max-rows n]   启动 stdio MCP server
```

## 在 ZCode 里接 MCP

本仓库自带 `.zcode/config.json`,注册了两个 workspace 级 server(打开本仓库即自动连接;**MCP 只在会话启动时连接,新注册/改配置后要开新会话才生效**):

```json
{
  "mcp": {
    "servers": {
      "text2sql":         { "command": "bun", "args": ["run", "src/cli.ts", "mcp", "--docs", "docs", "--db-dir", "eval/sample"] },
      "text2sql-spider":  { "command": "bun", "args": ["run", "src/cli.ts", "mcp", "--docs", "docs", "--db-dir", "eval/datasets/spider/database"] }
    }
  }
}
```

工具(`mcp__text2sql__*`):

| 工具 | 作用 |
|---|---|
| `search_schema` | 混合检索索引后的 schema 文档,返回带文件路径的命中 |
| `get_table_schema` | 读单表完整文档(列/外键/样本行/DDL) |
| `run_sql` | 执行单条 SELECT/WITH(仅只读;超出行数上限时截断) |
| `sample_rows` | 看某表前 N 行 |
| `list_databases` | 列出已连接的库(标签即 `db` 参数取值) |

`run_sql` 的只读限制是**双重**的:工具层只放行 `SELECT`/`WITH` 且禁止多语句;SQLite 一律以 readonly 打开。MySQL/Postgres 建议再配只读账号(工具层约束防误操作,不防特权账号)。

## 评测

### 数据集格式

```
<datasetDir>/
  questions.jsonl   {"id","db","question","evidence"?}   # evidence 是可选外部知识(BIRD)
  gold.jsonl        {"id","gold_sql"}                     # 与 questions 的 id 对应
```

gold 单独放一个文件,求解代理的 prompt 里不会出现 gold,也不告知其路径(软隔离,见下)。

### 跑评测

先按「快速开始」导出目标库文档并建索引,然后**打开本仓库根目录的 ZCode 会话**(workspace 级 MCP 自动连接),让 ZCode 用 `CreateWorkflow` 以 `path` 方式提交 `eval/text2sql-eval.workflow.ts`:

- 样例数据集(不传 args,等价于 `{"datasetDir":"eval/sample","limit":8,"toolPrefix":"mcp__text2sql__"}`)。
- Spider 数据集:传 args `{"datasetDir":"eval/datasets/spider-eval","toolPrefix":"mcp__text2sql-spider__","limit":10}`。

评测过程:每题一个求解子代理(只许 Read + `mcp__text2sql*__*`,先检索 schema 再写 SQL 并实际执行验证)→ 每题一个评审子代理(把候选 SQL 和 gold SQL 都在真实库上执行,比较结果集判定对错)→ 汇总执行准确率,输出逐题报告。

### 公开测试集

用 aria2 下载后,转换为本仓库格式(已验证的直链,2026-10 实测):

```bash
# Spider(95MB,ModelScope 镜像,含全部 SQLite 库;1034 dev 题 / 20 库)
aria2c --no-conf -c -x16 -s16 -o spider.zip \
  "https://www.modelscope.cn/api/v1/datasets/ModelM/spider/repo?Revision=master&FilePath=spider.zip"
unzip spider.zip -d eval/datasets/spider
bun run scripts/build-dataset.ts --format spider \
  --dev eval/datasets/spider/dev.json --out eval/datasets/spider-eval
# 导出 dev 涉及的 20 个库文档:eval/datasets/spider-eval/db-ids.txt 有库清单
bun run src/cli.ts index --docs docs   # 记得对导出后的 docs 建索引

# BIRD-SQL dev(330MB,官方阿里云 OSS 直链;1534 dev 题 / 11 库,含 evidence)
aria2c --no-conf -c -x16 -s16 -o bird-dev.zip \
  "https://bird-bench.oss-cn-beijing.aliyuncs.com/dev.zip"
unzip bird-dev.zip -d eval/datasets/bird
cd eval/datasets/bird/dev_20240627 && unzip -q -o dev_databases.zip -d . && cd -
bun run scripts/build-dataset.ts --format bird \
  --dev eval/datasets/bird/dev_20240627/dev.json --out eval/datasets/bird-eval
# MCP 指向:eval/datasets/bird/dev_20240627/dev_databases(可在 .zcode/config.json 加一个 server)
```

## 评测的约束边界(重要)

- 动态 workflow 的子代理**没有工具级裁剪**:它们都有 Bash 等命令行工具。「只允许读文件 + MCP」是通过 persona/ask 写进 prompt 的**软约束**(已实测:子代理可以调用 MCP 工具,纪律 prompt 有效约束常规行为,但无法防御恶意绕过)。
- 防作弊设计:gold SQL 只出现在评审代理的 prompt 里;gold 文件路径不告知求解代理;评测机不落任何含答案的全文检索索引。
- 如需硬约束,可在 ZCode 侧用权限配置对评测会话禁用 Bash,或在只读沙箱中运行。

## 项目结构

```
src/
  cli.ts            CLI 入口(export/index/search/sql/mcp)
  db/               适配器:sqlite(bun:sqlite 内置)/ mysql2 / pg,统一只读 SELECT
  export/schema2md  schema → markdown(逐表 + 总览/关系)
  mcp/server.ts     stdio MCP server(五个工具)
  zg.ts             zg 子进程封装(query/index)
scripts/
  make-demo-db.ts   生成自带样例库
  mcp-smoke.ts      MCP 冒烟测试(不依赖 ZCode)
  build-dataset.ts  Spider/BIRD → questions.jsonl + gold.jsonl
eval/
  sample/           demo 数据集 + demo.db
  text2sql-eval.workflow.ts   评测 workflow(ZCode dynamic workflow)
.zcode/config.json workspace 级 MCP 注册(打开仓库即连)
```
