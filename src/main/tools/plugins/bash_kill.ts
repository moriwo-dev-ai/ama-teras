import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export default {
  name: 'bash_kill',
  description:
    'bash の background:true で起動したバックグラウンドプロセスを強制終了する' +
    '(Windowsでは子孫プロセスも含めて終了)。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'bash(background:true) が返したプロセスid' },
    },
    required: ['id'],
  },
  risk: 'exec',
  tags: ['コマンド実行'],
  warnings: ['実行中のバックグラウンドプロセスを強制終了します'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { id } = input as { id?: unknown };
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return { content: 'id は整数で指定すること', isError: true };
    }
    if (!ctx.processes) {
      return {
        content: 'このコンテキストではバックグラウンドプロセスを利用できない(processes 未注入)',
        isError: true,
      };
    }
    const result = ctx.processes.kill(id);
    if (result === 'not-found') {
      return { content: `id=${id} のバックグラウンドプロセスは存在しない`, isError: true };
    }
    if (result === 'already-exited') {
      return { content: `id=${id} は既に終了している(最終出力は bash_output で確認できる)` };
    }
    return { content: `id=${id} に強制終了を要求した(終了状態は bash_output で確認できる)` };
  },
} satisfies ToolPlugin;
