import { spawn } from 'node:child_process';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

// 進化ジョブ用の制限モード(ctx.restrictExec)で許可するコマンド。
// bash は writeAllowlist を強制できないため、実行できるコマンド自体を検証系だけに絞る。
// シェル連結・リダイレクト・コマンド置換・node -e などによる任意書き込みを排除する。
const SHELL_METACHARS = /[;&|<>`\n]|\$\(|\$\{|\|\||&&/;
const RESTRICTED_ALLOW = [
  /^npm run [\w:-]+$/,
  /^npx vitest run(?: [^\s;&|<>`$]+)*$/,
  /^npx tsc(?: [^\s;&|<>`$]+)*$/,
];

/**
 * 制限モードでコマンドを許可してよいか。検証コマンド(npm run/npx vitest/npx tsc)のみ許可し、
 * シェルメタ文字(連結・リダイレクト・置換)を一切含まないことを要求する。
 * bash.ts はプラグイン規約により外部 import 不可のため、この判定をファイル内に持つ。
 */
export function isRestrictedCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  if (SHELL_METACHARS.test(trimmed)) return false;
  return RESTRICTED_ALLOW.some((re) => re.test(trimmed));
}

export default {
  name: 'bash',
  description:
    'シェルコマンドを実行して stdout/stderr を返す(Windowsではシステムシェル経由)。タイムアウト既定120秒。' +
    'background:true で待たずにバックグラウンド起動し id を返す(出力は bash_output、停止は bash_kill)。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '実行するコマンド' },
      timeout_ms: { type: 'integer', description: 'タイムアウト(ミリ秒、最大600000)' },
      background: {
        type: 'boolean',
        description: 'true なら完了を待たず即座に id を返す(dev server 等の常駐プロセス用)',
      },
    },
    required: ['command'],
  },
  risk: 'exec',
  warnings: ['child_process を使用して任意のシェルコマンドを実行します'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command, timeout_ms, background } = input as {
      command?: unknown;
      timeout_ms?: unknown;
      background?: unknown;
    };
    if (typeof command !== 'string' || command.trim() === '') {
      return { content: 'command は空でない文字列で指定すること', isError: true };
    }
    if (ctx.restrictExec && !isRestrictedCommandAllowed(command)) {
      return {
        content:
          '制限モード: このコマンドは許可されていない。進化ジョブでは検証コマンド' +
          '(npm run <script> / npx vitest run <path> / npx tsc)のみ実行できる。' +
          'ファイル変更は write_file / edit_file(plugins配下のみ)を使うこと。',
        isError: true,
      };
    }
    // M11-2: バックグラウンド起動。ProcessManager はコンテキスト経由で注入される
    // (進化ジョブには注入されないため、そこでは機械的に使えない)
    if (background === true) {
      if (!ctx.processes) {
        return {
          content:
            'バックグラウンド実行はこのコンテキストでは利用できない(processes が注入されていない)。' +
            'background を外して通常実行すること。',
          isError: true,
        };
      }
      const { id, pid } = ctx.processes.start(command, ctx.cwd);
      return {
        content:
          `バックグラウンドで起動した: id=${id}${pid !== undefined ? ` pid=${pid}` : ''}。` +
          `出力確認は bash_output {"id": ${id}}、停止は bash_kill {"id": ${id}}`,
      };
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
