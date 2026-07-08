import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export default {
  name: 'list_dir',
  description: 'ディレクトリ直下のエントリ一覧(名前、種別、サイズ)を返す。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '対象ディレクトリ(省略時はcwd)' },
    },
  },
  risk: 'safe',
  tags: ['ファイル操作'],
  pathParams: ['path'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path } = input as { path?: unknown };
    const target = typeof path === 'string' ? (isAbsolute(path) ? path : resolve(ctx.cwd, path)) : ctx.cwd;

    const entries = await readdir(target, { withFileTypes: true }).catch((err: unknown) => {
      return err instanceof Error ? err : new Error(String(err));
    });
    if (entries instanceof Error) return { content: `読めない: ${entries.message}`, isError: true };

    const lines = await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return `${e.name}/`;
        const st = await stat(join(target, e.name)).catch(() => null);
        return `${e.name}\t${st ? `${st.size} bytes` : '?'}`;
      }),
    );
    return { content: lines.length === 0 ? '(空ディレクトリ)' : lines.join('\n') };
  },
} satisfies ToolPlugin;
