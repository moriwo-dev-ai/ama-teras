import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

function writeAllowed(abs: string, ctx: ToolContext): boolean {
  if (!ctx.writeAllowlist) return true;
  const rel = relative(ctx.cwd, abs).replaceAll('\\', '/');
  if (rel.startsWith('..')) return false;
  return ctx.writeAllowlist.some((p) => {
    const prefix = p.replaceAll('\\', '/').replace(/\/+$/, '');
    return rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

export default {
  name: 'edit_file',
  description:
    'ファイル内の old_string を new_string に置換する。old_string はファイル内で一意であること(replace_all指定時を除く)。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '対象ファイル(相対はcwd基準)' },
      old_string: { type: 'string', description: '置換前の文字列(完全一致)' },
      new_string: { type: 'string', description: '置換後の文字列' },
      replace_all: { type: 'boolean', description: '全出現を置換する(既定: false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  risk: 'write',
  tags: ['ファイル操作'],
  pathParams: ['path'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, old_string, new_string, replace_all } = input as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
    };
    if (typeof path !== 'string' || typeof old_string !== 'string' || typeof new_string !== 'string') {
      return { content: 'path / old_string / new_string は文字列で指定すること', isError: true };
    }
    if (old_string === new_string) return { content: 'old_string と new_string が同一', isError: true };
    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
    if (!writeAllowed(abs, ctx)) {
      return { content: `書き込み許可外のパス: ${abs}(許可: ${ctx.writeAllowlist?.join(', ')})`, isError: true };
    }

    const raw = await readFile(abs, 'utf8').catch(() => null);
    if (raw === null) return { content: `ファイルが存在しない: ${abs}`, isError: true };

    const occurrences = raw.split(old_string).length - 1;
    if (occurrences === 0) return { content: 'old_string がファイル内に見つからない', isError: true };
    if (occurrences > 1 && replace_all !== true) {
      return { content: `old_string が ${occurrences} 箇所ある。一意にするか replace_all を使うこと`, isError: true };
    }

    const next = replace_all === true ? raw.replaceAll(old_string, new_string) : raw.replace(old_string, new_string);
    await writeFile(abs, next, 'utf8');
    ctx.log(`edited ${abs} (${occurrences} 箇所)`);
    return { content: `${abs} を編集した(${occurrences} 箇所置換)` };
  },
} satisfies ToolPlugin;
