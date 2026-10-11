export interface ZgRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the `zg` CLI. On Windows the binary is a `.cmd` shim, so go through cmd.
 * Override the binary with T2S_ZG_BIN.
 */
export async function runZg(args: string[], cwd?: string): Promise<ZgRunResult> {
  const bin = process.env.T2S_ZG_BIN ?? "zg";
  const cmd = process.platform === "win32" ? ["cmd", "/c", bin, ...args] : [bin, ...args];
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

/**
 * Semantic/keyword search over an indexed docs directory.
 * Returns zg's default agent-markdown output (ranked hits with file paths),
 * or an error message starting with "zg query failed".
 */
export async function zgSearch(docsDir: string, query: string, limit = 8): Promise<string> {
  const r = await runZg(["query", query, "--limit", String(limit)], docsDir);
  if (r.ok) return r.stdout;
  return `zg query failed (exit ${r.exitCode}):\n${r.stderr || r.stdout}`;
}

/** Build/refresh the zg index for a docs directory. */
export async function zgIndex(docsDir: string): Promise<ZgRunResult> {
  return runZg(["index"], docsDir);
}
