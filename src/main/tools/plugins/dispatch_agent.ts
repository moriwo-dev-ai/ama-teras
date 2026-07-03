import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export default {
  name: 'dispatch_agent',
  description:
    '調査タスクを読み取り専用の子エージェントに委譲し、結果の要約だけを受け取る。' +
    '大量のファイル探索・コード調査など、往復が多く親の文脈を汚したくない調査に使う。' +
    '子は read_file / list_dir / grep のみ使え、ファイル変更やコマンド実行はしない。',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '調査してほしい内容(自己完結した指示)' },
    },
    required: ['task'],
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { task } = input as { task?: unknown };
    if (typeof task !== 'string' || task.trim() === '') {
      return { content: 'task は空でない文字列で指定すること', isError: true };
    }
    if (!ctx.subagent) {
      return { content: 'この実行コンテキストではサブエージェントを起動できない', isError: true };
    }
    const summary = await ctx.subagent.run(task, ctx.signal);
    return { content: summary };
  },
} satisfies ToolPlugin;
