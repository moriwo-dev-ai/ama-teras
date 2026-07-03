import { spawn } from 'node:child_process';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export default {
  name: 'bash',
  description:
    'シェルコマンドを実行して stdout/stderr を返す(Windowsではシステムシェル経由)。タイムアウト既定120秒。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '実行するコマンド' },
      timeout_ms: { type: 'integer', description: 'タイムアウト(ミリ秒、最大600000)' },
    },
    required: ['command'],
  },
  risk: 'exec',
  warnings: ['child_process を使用して任意のシェルコマンドを実行します'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command, timeout_ms } = input as { command?: unknown; timeout_ms?: unknown };
    if (typeof command !== 'string' || command.trim() === '') {
      return { content: 'command は空でない文字列で指定すること', isError: true };
    }
    const timeout = Math.min(typeof timeout_ms === 'number' && timeout_ms > 0 ? timeout_ms : DEFAULT_TIMEOUT_MS, 600_000);

    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        signal: ctx.signal,
        timeout,
        env: process.env,
      });

      let out = '';
      const append = (chunk: Buffer): void => {
        if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);

      child.on('error', (err) => {
        resolvePromise({ content: `実行エラー: ${err.message}`, isError: true });
      });
      child.on('close', (code, signal) => {
        let content = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…(出力切り詰め)` : out;
        if (content.trim() === '') content = '(出力なし)';
        if (signal) {
          resolvePromise({ content: `${content}\n[シグナル ${signal} で終了(タイムアウトまたはキャンセル)]`, isError: true });
        } else if (code !== 0) {
          resolvePromise({ content: `${content}\n[exit code: ${code}]`, isError: true });
        } else {
          resolvePromise({ content });
        }
      });
    });
  },
} satisfies ToolPlugin;
