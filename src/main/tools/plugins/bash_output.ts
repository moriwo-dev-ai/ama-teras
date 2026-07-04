import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export default {
  name: 'bash_output',
  description:
    'bash の background:true で起動したプロセスの出力と実行状態を取得する。' +
    'since_byte に前回の total_bytes を渡すと増分だけ取れる。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'bash(background:true) が返したプロセスid' },
      since_byte: {
        type: 'integer',
        description: '前回取得時の total_bytes。指定バイト位置以降の出力だけを返す',
      },
    },
    required: ['id'],
  },
  risk: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { id, since_byte } = input as { id?: unknown; since_byte?: unknown };
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return { content: 'id は整数で指定すること', isError: true };
    }
    if (!ctx.processes) {
      return {
        content: 'このコンテキストではバックグラウンドプロセスを利用できない(processes 未注入)',
        isError: true,
      };
    }
    const since = typeof since_byte === 'number' && since_byte >= 0 ? since_byte : 0;
    const snap = ctx.processes.read(id, since);
    if (!snap) return { content: `id=${id} のバックグラウンドプロセスは存在しない`, isError: true };
    const state = snap.running
      ? '実行中'
      : `終了(exitCode=${snap.exitCode ?? 'null'}${snap.exitSignal !== null ? ` signal=${snap.exitSignal}` : ''})`;
    const dropped =
      snap.droppedBytes > 0 ? `(先頭${snap.droppedBytes}バイトはバッファ上限で切り捨て済み)` : '';
    const header = `[process ${snap.id}] ${state} total_bytes=${snap.totalBytes}${dropped}`;
    return { content: `${header}\n${snap.output === '' ? '(新しい出力なし)' : snap.output}` };
  },
} satisfies ToolPlugin;
