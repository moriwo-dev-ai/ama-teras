import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M108: バックグラウンドタスクの起動。隔離git worktreeでサブエージェントが作業し、
 * 本体の会話・作業ディレクトリは一切ブロックされない。完了すると「[bg-task #N 完了]」が
 * 会話へ自動投入され、変更は diff として提示 → apply_background_task(承認制)で取り込む。
 */

interface DispatchInput {
  instruction: string;
}

function isDispatchInput(value: unknown): value is DispatchInput {
  return (
    typeof value === 'object' && value !== null && typeof (value as { instruction?: unknown }).instruction === 'string'
  );
}

export default {
  name: 'dispatch_background',
  description:
    'Run a file-editing task in an isolated git worktree in the background (main workspace is untouched and you can keep working). The sub-agent can only read/write files (no command execution). On completion, "[bg-task #N]" with the diff is injected into this conversation; merge it with apply_background_task (human-approved) or discard it. Requires the workspace to be a git repository.',
  inputSchema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'Self-contained task instruction (the sub-agent has no other context — include file paths and goals)',
      },
    },
    required: ['instruction'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['自律'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isDispatchInput(input) || input.instruction.trim() === '') {
      return { content: 'Input must be {instruction: string} (non-empty).', isError: true };
    }
    if (ctx.backgroundTasks === undefined) {
      return { content: 'この実行文脈ではバックグラウンドタスクは使えない(会話ランでのみ有効。ネスト不可)', isError: true };
    }
    try {
      const { id } = await ctx.backgroundTasks.dispatch(input.instruction.trim());
      return {
        content: `バックグラウンドタスク #${id} を隔離worktreeで開始した。完了時に [bg-task #${id}] が会話へ自動投入される。それまで他の作業を続けてよい。現況:\n${ctx.backgroundTasks.status()}`,
      };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
} satisfies ToolPlugin;
