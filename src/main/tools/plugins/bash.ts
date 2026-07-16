import { spawn } from 'node:child_process';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

// 進化ジョブ用の制限モード(ctx.restrictExec)で許可するコマンド。
// bash は writeAllowlist を強制できないため、実行できるコマンド自体を検証系だけに絞る。
// シェル連結・リダイレクト・コマンド置換・node -e などによる任意書き込みを排除する。
const SHELL_METACHARS = /[;&|<>`\n]|\$\(|\$\{|\|\||&&/;
// M92(過剰探索対策): vitest は**ちょうど1つのパス引数**を必須にする。
// 以前は `(?: <path>)*` で「引数ゼロ(=全スイート実行)」も「複数ファイル」も通っていた。
// これが実測 #33 の最大の時間・費用の無駄(自明ツールの生成中にリポジトリ全体のテストを回した)だった。
// 生成ジョブが検証すべきは自分の <name>.test.ts の1本だけなので、単一パス必須に絞る。
const RESTRICTED_ALLOW = [
  /^npm run [\w:-]+$/,
  /^npx vitest run [^\s;&|<>`$]+$/,
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

/**
 * 常駐(dev server / watch)系コマンドの検知。同期実行するとタイムアウトまで待って
 * 打ち切られるだけなので、結果に background:true 推奨のヒントを付ける(実行は止めない)。
 * 判定はヒューリスティック — build 等の一過性コマンドを誤検知しないよう保守的に。
 */
const LONG_RUNNING_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview)\b/,
  /\bvite\s*$/,
  /\bvite\s+(?:dev|serve|preview)\b/,
  /\b(?:next|nuxt|astro)\s+dev\b/,
  /\bwebpack(?:-dev-server)?\s+(?:serve|watch)\b/,
  /\bnodemon\b/,
  /--watch\b/,
  /\bvitest\s*$/, // 引数なし vitest は watch モード(vitest run は対象外)
  /\bnode\s+\S*(?:server|serve)\S*\.[cm]?js\b/,
];

export function looksLikeLongRunning(command: string): boolean {
  const trimmed = command.trim();
  return LONG_RUNNING_PATTERNS.some((re) => re.test(trimmed));
}

const LONG_RUNNING_ADVISORY =
  '[ヒント] このコマンドは常駐(dev/serve/watch)系に見える。同期実行はタイムアウトまで待って' +
  '打ち切られるだけなので、background:true での起動を推奨(出力は bash_output、停止は bash_kill)。';

export default {
  name: 'bash',
  description:
    'シェルコマンドを実行して stdout/stderr を返す(Windowsではシステムシェル経由)。タイムアウト既定120秒。' +
    'background:true で待たずにバックグラウンド起動し id を返す(出力は bash_output、停止は bash_kill)。' +
    'stdin は接続されない: 対話プロンプトを出すコマンド(npm create / git init 対話等の scaffold 系)は' +
    '非対話フラグ(-y, --yes, --no-interactive 等)を付けるか、ファイルを write_file で直接生成すること。',
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
  tags: ['コマンド実行'],
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

    // spawn の signal / timeout はシェルだけを殺し、孫プロセスが stdio を握っていると
    // 'close' が発火せず await が永久に返らない(M11で既知・M12ベンチで実害化)。
    // → タイムアウト/キャンセル時は子孫ツリーごと強制killし、フォールバックタイマーで必ず解決する。
    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        signal: ctx.signal,
        timeout,
        env: process.env,
        windowsHide: true,
      });

      let out = '';
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      // 常駐系らしきコマンドの同期実行にはヒントを付ける(どの終わり方でも)
      const advisory = looksLikeLongRunning(command) ? `\n${LONG_RUNNING_ADVISORY}` : '';
      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        ctx.signal.removeEventListener('abort', onAbort);
        resolvePromise(advisory === '' ? result : { ...result, content: `${result.content}${advisory}` });
      };
      const tailOf = (): string => {
        let content = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…(出力切り詰め)` : out;
        if (content.trim() === '') content = '(出力なし)';
        return content;
      };
      const killTree = (): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
            'error',
            () => child.kill(),
          );
        } else {
          child.kill('SIGKILL'); // POSIXは直接の子のみ(孫はspawnのsignal/timeoutが処理)
        }
      };
      const forceResolveAfter = (ms: number, reason: string): void => {
        const t = setTimeout(() => finish({ content: `${tailOf()}\n[${reason}]`, isError: true }), ms);
        t.unref?.();
        timers.push(t);
      };
      const onAbort = (): void => {
        killTree();
        forceResolveAfter(2000, 'キャンセルにより子プロセスツリーを強制終了した');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      // タイムアウト時: spawn 自身のkillで close が来なければツリーkill→強制解決
      const timeoutFallback = setTimeout(() => {
        killTree();
        forceResolveAfter(
          2000,
          `タイムアウト(${Math.round(timeout / 1000)}s)により子プロセスツリーを強制終了した`,
        );
      }, timeout + 500);
      timeoutFallback.unref?.();
      timers.push(timeoutFallback);

      // M21-4: 実行中のstdout末尾をUIへライブ配信(初回は即時・以降1秒スロットル)
      let lastProgressAt = 0;
      const emitProgress = (): void => {
        const now = Date.now();
        if (now - lastProgressAt < 1000) return;
        lastProgressAt = now;
        const lines = out.split(/\r?\n/);
        ctx.log(lines.slice(-5).join('\n').slice(-600));
      };
      const append = (chunk: Buffer): void => {
        if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
        emitProgress();
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);

      child.on('error', (err) => {
        finish({ content: `実行エラー: ${err.message}`, isError: true });
      });
      child.on('close', (code, signal) => {
        const content = tailOf();
        if (signal) {
          finish({ content: `${content}\n[シグナル ${signal} で終了(タイムアウトまたはキャンセル)]`, isError: true });
        } else if (code !== 0) {
          finish({ content: `${content}\n[exit code: ${code}]`, isError: true });
        } else {
          finish({ content });
        }
      });
    });
  },
} satisfies ToolPlugin;
