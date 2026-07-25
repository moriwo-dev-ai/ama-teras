import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M107: 自己ウェイクアップ — 「N秒後に自分を起こしてこの作業を続ける」。
 * CIやビルドなど待ち時間のあるタスクを、人間の再依頼なしで完走するための道具。
 * 期限が来ると「[wakeup] note」がこの会話へ自動投入される(実行中なら次ターン境界、
 * アイドルなら新しい指示として)。セッション内のみ=アプリを再起動すると予約は消える。
 */

const MIN_DELAY_SEC = 60;
const MAX_DELAY_SEC = 3600;

interface ScheduleWakeupInput {
  delaySec: number;
  note: string;
}

function isScheduleWakeupInput(value: unknown): value is ScheduleWakeupInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { delaySec?: unknown; note?: unknown };
  return typeof v.delaySec === 'number' && Number.isFinite(v.delaySec) && typeof v.note === 'string';
}

export default {
  name: 'schedule_wakeup',
  description:
    'Schedule a self-wakeup: after delaySec (60-3600, clamped), "[wakeup] <note>" is injected into this conversation so you can resume work (e.g. check a build/CI that needs time). Session-only — cleared on app restart. Write the note as an instruction to your future self.',
  inputSchema: {
    type: 'object',
    properties: {
      delaySec: { type: 'number', description: 'Seconds until wakeup (60-3600, clamped)' },
      note: { type: 'string', description: 'What to do on wakeup (instruction to your future self)' },
    },
    required: ['delaySec', 'note'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['自律'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isScheduleWakeupInput(input)) {
      return { content: 'Input must be {delaySec: number, note: string}.', isError: true };
    }
    if (ctx.wakeups === undefined) {
      // 進化ジョブ・手動実行など、再開先の会話が無い文脈では使えない(明示エラー)
      return { content: 'この実行文脈ではウェイクアップ予約は使えない(会話ランでのみ有効)', isError: true };
    }
    if (input.note.trim() === '') return { content: 'note が空。起きたとき何をするかを書くこと。', isError: true };
    const clamped = Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, Math.round(input.delaySec)));
    const { id, fireAtIso } = ctx.wakeups.schedule(clamped, input.note.trim());
    const clampNote = clamped !== Math.round(input.delaySec) ? `(${MIN_DELAY_SEC}〜${MAX_DELAY_SEC}秒にクランプ)` : '';
    return {
      content: `ウェイクアップ #${id} を予約した: ${clamped}秒後(${fireAtIso})${clampNote}。時間になると「[wakeup] ${input.note.trim().slice(0, 80)}」が投入される。アプリ再起動で予約は消える。`,
    };
  },
} satisfies ToolPlugin;
