import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M12-2: 計画ファイル。エージェント自身が管理するタスクリスト(MYCODEX_PLAN.md)。
 * - 書き込み先は workspace 直下のこの1ファイルに固定(path 入力なし=スコープ迂回の余地なし)。
 *   固定ファイル・ユーザーが目視できる内容のため risk は 'safe'
 * - 計画は毎ターン system prompt に「## 現在の計画」として注入される(compaction で失われない)
 * - 進化ジョブ(writeAllowlist コンテキスト)では write を拒否する(B worktree を汚さない)
 */

const PLAN_FILENAME = 'MYCODEX_PLAN.md';
const MAX_PLAN_BYTES = 64 * 1024;

export default {
  name: 'plan',
  description:
    '作業計画ファイル(MYCODEX_PLAN.md)の読み書き。複数ステップの作業では、最初に action:"write" で ' +
    '「- [ ] 項目」形式のチェックリストとして計画を書き、項目が完了するたびに「- [x]」へ更新した全文で ' +
    '上書きすること。計画は毎ターン system prompt へ注入されるため、会話が長くなっても失われない。' +
    'action:"read" で現在の計画を確認できる。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write'], description: 'read=現在の計画を返す / write=全置換' },
      content: { type: 'string', description: 'action:"write" のときの計画全文(markdown)' },
    },
    required: ['action'],
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { action, content } = (input ?? {}) as { action?: unknown; content?: unknown };
    const file = join(ctx.cwd, PLAN_FILENAME);

    if (action === 'read') {
      try {
        return { content: await readFile(file, 'utf8') };
      } catch {
        return { content: '(計画はまだ無い。action:"write" で作成できる)' };
      }
    }

    if (action === 'write') {
      // 進化ジョブ(writeAllowlist が注入されるコンテキスト)では計画ファイルを作らせない。
      // B worktree 直下に allowlist 外ファイルが生まれると差分検査ゲートが不合格になるため
      if (ctx.writeAllowlist) {
        return { content: '進化ジョブ内では plan は使用不可(writeAllowlist コンテキスト)', isError: true };
      }
      if (typeof content !== 'string') {
        return { content: 'action:"write" には content(string)が必要', isError: true };
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_PLAN_BYTES) {
        return { content: `計画が大きすぎる(上限 ${MAX_PLAN_BYTES / 1024}KB)。要点だけに絞ること`, isError: true };
      }
      await writeFile(file, content, 'utf8');
      return { content: `計画を更新した(${PLAN_FILENAME})` };
    }

    return { content: 'action は "read" か "write"', isError: true };
  },
} satisfies ToolPlugin;
