import type { ToolContext, ToolPlugin, ToolResult } from '../types';

const MAX_PARALLEL = 3;

function parseTasks(input: unknown): { tasks: string[]; mode: 'read' | 'work' } | string {
  const { task, mode, parallel } = (input ?? {}) as {
    task?: unknown;
    mode?: unknown;
    parallel?: unknown;
  };
  if (mode !== undefined && mode !== 'read' && mode !== 'work') {
    return 'mode は "read" か "work"';
  }
  const resolvedMode: 'read' | 'work' = mode === 'work' ? 'work' : 'read';
  if (parallel !== undefined) {
    if (!Array.isArray(parallel) || parallel.length === 0) {
      return 'parallel は {task} の配列(1件以上)で指定すること';
    }
    if (parallel.length > MAX_PARALLEL) {
      return `parallel は最大 ${MAX_PARALLEL} 件まで。タスクを統合するか複数回に分けること`;
    }
    const tasks: string[] = [];
    for (const item of parallel) {
      const t = (item as { task?: unknown } | null)?.task;
      if (typeof t !== 'string' || t.trim() === '') return 'parallel の各要素は {task: string}';
      tasks.push(t);
    }
    return { tasks, mode: resolvedMode };
  }
  if (typeof task !== 'string' || task.trim() === '') {
    return 'task は空でない文字列で指定すること(または parallel を指定)';
  }
  return { tasks: [task], mode: resolvedMode };
}

export default {
  name: 'dispatch_agent',
  description:
    'タスクを子エージェントへ委譲する。mode:"read"(既定)は読み取り専用の調査' +
    '(read_file / list_dir / grep のみ・親の文脈を汚さない)。mode:"work" は編集・コマンド実行も' +
    'できる作業委譲(各ツールはユーザー承認制の場合がある)。parallel に {task} の配列(最大3)を' +
    '渡すと並列実行する。並列タスクは互いに触るファイルが重ならないように分割すること' +
    '(同一ファイルへの書き込みは2件目以降が拒否される)。',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '委譲する内容(自己完結した指示。parallel 指定時は不要)' },
      mode: {
        type: 'string',
        enum: ['read', 'work'],
        description: 'read=読み取り専用の調査(既定) / work=編集・実行込みの作業',
      },
      parallel: {
        type: 'array',
        description: '並列タスク(最大3)。触るファイルが重ならないように分割すること',
        items: {
          type: 'object',
          properties: { task: { type: 'string', description: '自己完結した指示' } },
          required: ['task'],
        },
      },
    },
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.subagent) {
      return { content: 'この実行コンテキストではサブエージェントを起動できない', isError: true };
    }
    const parsed = parseTasks(input);
    if (typeof parsed === 'string') return { content: parsed, isError: true };
    const { tasks, mode } = parsed;

    // 後方互換: mode 未指定・単発タスクは従来の read 専用経路をそのまま通す(挙動不変)
    const { mode: rawMode, parallel: rawParallel } = (input ?? {}) as {
      mode?: unknown;
      parallel?: unknown;
    };
    if (rawMode === undefined && rawParallel === undefined) {
      return { content: await ctx.subagent.run(tasks[0]!, ctx.signal) };
    }

    if (!ctx.subagent.runParallel) {
      if (mode === 'read' && tasks.length === 1) {
        return { content: await ctx.subagent.run(tasks[0]!, ctx.signal) };
      }
      return { content: 'この実行コンテキストでは work/parallel を使用できない', isError: true };
    }
    const summaries = await ctx.subagent.runParallel(tasks, mode, ctx.signal);
    if (summaries.length === 1) return { content: summaries[0]! };
    return {
      content: summaries
        .map((s, i) => `── サブエージェント結果 ${i + 1}/${summaries.length} ──\n${s}`)
        .join('\n\n'),
    };
  },
} satisfies ToolPlugin;
