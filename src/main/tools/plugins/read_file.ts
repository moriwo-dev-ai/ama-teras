import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

const MAX_CHARS = 50_000;
const NUL = '\x00';

export default {
  name: 'read_file',
  description:
    'テキストファイルを読む。offset(1始まりの行番号)と limit(行数)で部分読みできる。出力は行番号付き。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '対象ファイル(相対はcwd基準)' },
      offset: { type: 'integer', description: '読み始める行番号(1始まり)' },
      limit: { type: 'integer', description: '読む行数' },
    },
    required: ['path'],
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, offset, limit } = input as { path?: unknown; offset?: unknown; limit?: unknown };
    if (typeof path !== 'string') return { content: 'path は文字列で指定すること', isError: true };
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);

    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return { content: `ファイルが存在しない: ${abs}`, isError: true };

    const raw = await readFile(abs, 'utf8');
    if (raw.includes(NUL)) return { content: `バイナリファイルは読めない: ${abs}`, isError: true };

    const lines = raw.split('\n');
    const start = typeof offset === 'number' && offset > 0 ? offset - 1 : 0;
    const count = typeof limit === 'number' && limit > 0 ? limit : lines.length - start;
    const slice = lines.slice(start, start + count);

    let body = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
    if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}\n…(${body.length}文字中${MAX_CHARS}文字で切り詰め)`;
    return { content: body === '' ? '(空ファイル)' : body };
  },
} satisfies ToolPlugin;
