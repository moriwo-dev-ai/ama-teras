import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

function writeAllowed(abs: string, ctx: ToolContext): boolean {
  if (!ctx.writeAllowlist) return true;
  const absNorm = abs.replaceAll('\\', '/');
  const rel = relative(ctx.cwd, abs).replaceAll('\\', '/');
  return ctx.writeAllowlist.some((p) => {
    const prefix = p.replaceAll('\\', '/').replace(/\/+$/, '');
    // M125: 絶対パスの許可エントリ(配信モードの world-apps 限定などcwd外の作業場所)
    if (isAbsolute(p)) {
      const a = process.platform === 'win32' ? absNorm.toLowerCase() : absNorm;
      const b = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
      return a === b || a.startsWith(`${b}/`);
    }
    if (rel.startsWith('..')) return false;
    return rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

export default {
  name: 'write_file',
  description: 'ファイルを新規作成または全上書きする。親ディレクトリは自動作成。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '対象ファイル(相対はcwd基準)' },
      content: { type: 'string', description: '書き込む内容全体' },
    },
    required: ['path', 'content'],
  },
  risk: 'write',
  tags: ['ファイル操作'],
  pathParams: ['path'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, content } = input as { path?: unknown; content?: unknown };
    if (typeof path !== 'string' || typeof content !== 'string') {
      return { content: 'path と content は文字列で指定すること', isError: true };
    }
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
    if (!writeAllowed(abs, ctx)) {
      return { content: `書き込み許可外のパス: ${abs}(許可: ${ctx.writeAllowlist?.join(', ')})`, isError: true };
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    ctx.log(`wrote ${abs}`);
    return { content: `${abs} に ${content.length} 文字を書き込んだ` };
  },
} satisfies ToolPlugin;
