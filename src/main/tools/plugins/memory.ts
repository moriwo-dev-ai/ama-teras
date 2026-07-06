import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M13-1: 長期記憶ツール。エージェント自身が AMATERAS.md(プロジェクト記憶)を管理する。
 * - 書き込み先は workspace 直下のこの1ファイルに固定(path 入力なし)。人間も Settings から
 *   同じファイルを編集できる(共同編集)。内容は毎ターン system prompt に注入される
 * - append は「## 学習メモ」節へタイムスタンプ付き1行を追記(発見した知見の置き場)
 * - rewrite は全置換(肥大したときの整理用)
 * - 進化ジョブ(writeAllowlist コンテキスト)では書き込み系を拒否する
 * - M17-1: 旧名 MYCODEX.md は読み込み後方互換+初回書き込み時に新名へ移行。
 *   プラグインは実行時トランスパイルされるため、互換ロジックはこのファイル内で自己完結させる
 */

const MEMORY_FILENAME = 'AMATERAS.md';
const LEGACY_MEMORY_FILENAME = 'MYCODEX.md';
const LEARNED_SECTION = '## 学習メモ';
const MAX_APPEND_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 256 * 1024;

function timestamp(): string {
  // ローカル時刻の "YYYY-MM-DD HH:mm"(秒・タイムゾーンは記憶用途では不要)
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function appendToLearnedSection(existing: string, entry: string): string {
  const line = `- [${timestamp()}] ${entry.replace(/\r?\n/g, ' ').trim()}`;
  if (existing.includes(LEARNED_SECTION)) {
    // 節の末尾(次の見出しの直前 or ファイル末尾)に追記する
    const idx = existing.indexOf(LEARNED_SECTION);
    const afterSection = existing.slice(idx);
    const nextHeading = afterSection.slice(LEARNED_SECTION.length).search(/^## /m);
    if (nextHeading >= 0) {
      const insertAt = idx + LEARNED_SECTION.length + nextHeading;
      return `${existing.slice(0, insertAt).trimEnd()}\n${line}\n\n${existing.slice(insertAt)}`;
    }
    return `${existing.trimEnd()}\n${line}\n`;
  }
  const base = existing.trim() === '' ? '' : `${existing.trimEnd()}\n\n`;
  return `${base}${LEARNED_SECTION}\n${line}\n`;
}

function resolveReadPath(cwd: string): string {
  const next = join(cwd, MEMORY_FILENAME);
  if (existsSync(next)) return next;
  const legacy = join(cwd, LEGACY_MEMORY_FILENAME);
  return existsSync(legacy) ? legacy : next;
}

async function migrateLegacy(cwd: string): Promise<void> {
  const next = join(cwd, MEMORY_FILENAME);
  const legacy = join(cwd, LEGACY_MEMORY_FILENAME);
  if (existsSync(next) || !existsSync(legacy)) return;
  await rename(legacy, next).catch(() => {
    /* 移行失敗でも読み取りフォールバックが効く */
  });
}

export default {
  name: 'memory',
  description:
    'プロジェクト記憶(AMATERAS.md)の管理。今後も使う知見(ビルド方法・規約・ハマりどころ)を ' +
    '発見したら action:"append" で短く追記すること(「## 学習メモ」節にタイムスタンプ付きで入る)。' +
    '会話固有の一時的な内容は書かないこと。action:"read" で現在の記憶を確認、' +
    'action:"rewrite" は肥大した記憶を整理するときの全置換。記憶は毎ターン system prompt に注入される。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'append', 'rewrite'],
        description: 'read=現在の記憶 / append=学習メモへ1件追記 / rewrite=全置換(整理用)',
      },
      content: { type: 'string', description: 'append: 追記する知見(短く) / rewrite: 新しい全文' },
    },
    required: ['action'],
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { action, content } = (input ?? {}) as { action?: unknown; content?: unknown };
    const file = join(ctx.cwd, MEMORY_FILENAME);
    const current = await readFile(resolveReadPath(ctx.cwd), 'utf8').catch(() => '');

    if (action === 'read') {
      return { content: current === '' ? '(記憶はまだ無い)' : current };
    }

    if (action !== 'append' && action !== 'rewrite') {
      return { content: 'action は "read" / "append" / "rewrite"', isError: true };
    }
    // 進化ジョブでは記憶を書き換えさせない(B worktree を汚さない・A の記憶に干渉しない)
    if (ctx.writeAllowlist) {
      return { content: '進化ジョブ内では memory の書き込みは使用不可', isError: true };
    }
    if (typeof content !== 'string' || content.trim() === '') {
      return { content: `action:"${action}" には content(string)が必要`, isError: true };
    }

    if (action === 'append') {
      if (Buffer.byteLength(content, 'utf8') > MAX_APPEND_BYTES) {
        return { content: `追記が大きすぎる(上限 ${MAX_APPEND_BYTES / 1024}KB)。要点だけに絞ること`, isError: true };
      }
      const next = appendToLearnedSection(current, content);
      if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) {
        return {
          content: `記憶ファイルが上限(${MAX_FILE_BYTES / 1024}KB)を超える。action:"rewrite" で整理すること`,
          isError: true,
        };
      }
      await migrateLegacy(ctx.cwd);
      await writeFile(file, next, 'utf8');
      return { content: `学習メモへ追記した(${MEMORY_FILENAME})` };
    }

    // rewrite
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      return { content: `記憶が大きすぎる(上限 ${MAX_FILE_BYTES / 1024}KB)`, isError: true };
    }
    await migrateLegacy(ctx.cwd);
    await writeFile(file, content, 'utf8');
    return { content: `記憶を書き換えた(${MEMORY_FILENAME})` };
  },
} satisfies ToolPlugin;
