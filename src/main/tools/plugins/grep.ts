import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.vite']);
const MAX_RESULTS = 200;
const MAX_FILE_SIZE = 1024 * 1024;
const NUL = '\x00';

async function* walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
  if (signal.aborted) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (signal.aborted) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full, signal);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

export default {
  name: 'grep',
  description:
    '正規表現でファイル内容を検索し「相対パス:行番号: 内容」を返す。node_modules等は除外。最大200件。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript正規表現' },
      path: { type: 'string', description: '検索起点ディレクトリ(省略時はcwd)' },
      include: { type: 'string', description: 'ファイル名に含まれるべき部分文字列(例: ".ts")' },
    },
    required: ['pattern'],
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path, include } = input as { pattern?: unknown; path?: unknown; include?: unknown };
    if (typeof pattern !== 'string') return { content: 'pattern は文字列で指定すること', isError: true };

    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return { content: `不正な正規表現: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    const root = typeof path === 'string' ? (isAbsolute(path) ? path : resolve(ctx.cwd, path)) : ctx.cwd;
    const results: string[] = [];

    for await (const file of walk(root, ctx.signal)) {
      if (results.length >= MAX_RESULTS) break;
      if (typeof include === 'string' && !file.includes(include)) continue;
      const st = await stat(file).catch(() => null);
      if (!st || st.size > MAX_FILE_SIZE) continue;
      const raw = await readFile(file, 'utf8').catch(() => null);
      if (raw === null || raw.includes(NUL)) continue;
      const rel = relative(root, file).replaceAll('\\', '/');
      for (const [i, line] of raw.split('\n').entries()) {
        if (re.test(line)) {
          results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
          if (results.length >= MAX_RESULTS) break;
        }
      }
    }

    if (results.length === 0) return { content: '(一致なし)' };
    const header = results.length >= MAX_RESULTS ? `(上限${MAX_RESULTS}件で打ち切り)\n` : '';
    return { content: header + results.join('\n') };
  },
} satisfies ToolPlugin;
