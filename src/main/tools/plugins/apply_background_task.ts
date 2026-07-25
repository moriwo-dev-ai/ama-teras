import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M108: バックグラウンドタスクの取り込み/破棄。取り込みは本体workspaceへの書き込みなので
 * risk:'write' = 通常の承認フロー(自動承認OFFなら承認ダイアログ)を必ず通る。
 * diff本文はタスク完了時に会話へ提示済み(このツールの承認が「diffを見た上での取り込み判断」)。
 */

interface ApplyInput {
  taskId: number;
  /** 'apply'(既定)= patchを本体へ適用 / 'discard' = worktree破棄のみ(本体無傷) */
  action?: 'apply' | 'discard';
}

function isApplyInput(value: unknown): value is ApplyInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { taskId?: unknown; action?: unknown };
  if (typeof v.taskId !== 'number' || !Number.isInteger(v.taskId)) return false;
  return v.action === undefined || v.action === 'apply' || v.action === 'discard';
}

export default {
  name: 'apply_background_task',
  description:
    'Merge (or discard) a finished background task. action:"apply" applies the task\'s diff to the main workspace (requires approval — the diff was shown when the task completed); action:"discard" throws the worktree away leaving the workspace untouched.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'number', description: 'Task id from dispatch_background / [bg-task #N]' },
      action: { type: 'string', enum: ['apply', 'discard'], description: 'Default: apply' },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
  risk: 'write',
  tags: ['自律'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isApplyInput(input)) {
      return { content: 'Input must be {taskId: number, action?: "apply"|"discard"}.', isError: true };
    }
    if (ctx.backgroundTasks === undefined) {
      return { content: 'この実行文脈ではバックグラウンドタスクは使えない(会話ランでのみ有効)', isError: true };
    }
    try {
      const message =
        (input.action ?? 'apply') === 'apply'
          ? await ctx.backgroundTasks.apply(input.taskId)
          : await ctx.backgroundTasks.discard(input.taskId);
      return { content: message };
    } catch (err) {
      return { content: `失敗: ${err instanceof Error ? err.message : String(err)}(本体は無傷)`, isError: true };
    }
  },
} satisfies ToolPlugin;
