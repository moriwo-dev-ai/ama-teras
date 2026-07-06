import { spawn } from 'node:child_process';
import type { EvolutionGateResult, EvolutionScope } from '../../shared/types';
import { assertSafeToolName } from '../tools/name';
import { runGit } from './git';
import { checkProtectedTripwire } from './protected';

export type CommandRunner = (
  command: string,
  cwd: string,
  env?: Record<string, string>,
) => Promise<{ code: number; output: string }>;

/** 既定のコマンド実行(シェル経由、10分タイムアウト) */
export const defaultRunCommand: CommandRunner = (command, cwd, env) =>
  new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, ...env },
    });
    let output = '';
    const append = (b: Buffer): void => {
      if (output.length < 100_000) output += b.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => resolve({ code: 1, output: `${output}\n${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });

export interface GateOptions {
  /** A(稼働リポジトリ)。差分検査のgit実行場所 */
  repoDir: string;
  /** B(worktree)。typecheck/vitest/build/smokeの実行場所 */
  worktreeDir: string;
  branch: string;
  baseRef: string;
  /** M20: 進化スコープ(既定 'tool'=従来挙動) */
  scope?: EvolutionScope;
  /** 進化ジョブが変更してよいパス接頭辞(リポジトリルート相対、/区切り) */
  allowedPaths: string[];
  /** スモーク対象の新ツール(scope='tool' では必須) */
  toolName?: string;
  /** スモーク入力JSONファイル(B内の絶対パス)。省略時は入力なし */
  smokeInputPath?: string;
  runCommand?: CommandRunner;
}

/**
 * M20: 危険操作の機械検出(ゲート2)。合否は変えず、昇格ダイアログの明示警告として使う。
 * child_process / ネットワーク / eval・Function・動的import を diff テキストから検出する
 */
export function detectDangerWarnings(diffText: string): string[] {
  const warnings: string[] = [];
  if (/child_process|execFile|spawn\s*\(/.test(diffText)) {
    warnings.push('child_process(コマンド実行)を使用するコードを含む');
  }
  if (/fetch\s*\(|node:https?|node:net|node:dgram|XMLHttpRequest|WebSocket/.test(diffText)) {
    warnings.push('ネットワークアクセスを行う可能性のあるコードを含む');
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(diffText)) {
    warnings.push('動的コード実行(eval / new Function)を含む');
  }
  if (/\bimport\s*\(\s*[^'"\s)]/.test(diffText)) {
    warnings.push('変数を引数にした動的import()を含む');
  }
  return warnings;
}

export interface GatesOutcome {
  ok: boolean;
  results: EvolutionGateResult[];
}

function isAllowedPath(file: string, allowedPaths: string[]): boolean {
  const norm = file.replaceAll('\\', '/');
  return allowedPaths.some((p) => {
    const prefix = p.replaceAll('\\', '/').replace(/\/+$/, '');
    return norm === prefix || norm.startsWith(`${prefix}/`);
  });
}

/** ゲート1(最終防衛線を最初に実行): 変更ファイルが許可パスのみか検査する */
export async function checkDiffAllowlist(
  repoDir: string,
  baseRef: string,
  branch: string,
  allowedPaths: string[],
): Promise<EvolutionGateResult> {
  const out = await runGit(['diff', '--name-only', `${baseRef}...${branch}`], repoDir);
  const files = out === '' ? [] : out.split('\n');
  if (files.length === 0) {
    return { name: 'diff_allowlist', ok: false, detail: '変更ファイルが無い(生成物なし)' };
  }
  const violations = files.filter((f) => !isAllowedPath(f, allowedPaths));
  if (violations.length > 0) {
    return {
      name: 'diff_allowlist',
      ok: false,
      detail: `保護領域/許可外パスへの変更を検出: ${violations.join(', ')}`,
    };
  }
  return { name: 'diff_allowlist', ok: true, detail: `変更 ${files.length} ファイル(すべて許可パス内)` };
}

/**
 * 検証ゲート。全合格が昇格条件。
 * M20の順序(厳守): protected → danger → diff_allowlist → typecheck → vitest → build → smoke。
 * protected(聖域トリップワイヤ)を無条件で最初に置くのは、聖域を書き換えた生成コードを
 * 後続ゲート(=コード実行を伴う)で走らせる前に、承認ダイアログにも出さずに落とすため。
 * 判定は稼働中A側の PROTECTED_PATHS 定数のみで行う(protected.ts の不変条件)。
 */
export async function runGates(opts: GateOptions): Promise<GatesOutcome> {
  const scope = opts.scope ?? 'tool';
  if (scope === 'tool') {
    // toolName はスモークコマンドへ shell 補間されるため、コマンド組み立て前に必ず検証する
    if (opts.toolName === undefined) throw new Error("scope='tool' には toolName が必要");
    assertSafeToolName(opts.toolName);
  }
  const run = opts.runCommand ?? defaultRunCommand;
  const results: EvolutionGateResult[] = [];
  const fail = (): GatesOutcome => ({ ok: false, results });

  // ゲート1: 聖域トリップワイヤ(最優先・無条件)
  results.push(await checkProtectedTripwire(opts.repoDir, opts.baseRef, opts.branch));
  if (!results[0]!.ok) return fail();

  // ゲート2: 危険検出(常にpass。警告として記録し、昇格ダイアログで明示される)
  const diffText = await runGit(['diff', `${opts.baseRef}...${opts.branch}`], opts.repoDir);
  const warnings = detectDangerWarnings(diffText);
  results.push({
    name: 'danger',
    ok: true,
    detail: warnings.length > 0 ? `警告: ${warnings.join(' / ')}` : '危険パターンなし',
  });

  // ゲート3: スコープ別allowlist
  results.push(await checkDiffAllowlist(opts.repoDir, opts.baseRef, opts.branch, opts.allowedPaths));
  if (!results[2]!.ok) return fail();

  const commands: { name: string; command: string; env?: Record<string, string> }[] = [
    { name: 'typecheck', command: 'npm run typecheck' },
    { name: 'vitest', command: 'npx vitest run' },
  ];
  if (scope === 'tool') {
    // 従来どおり: build+ツールスモークを1ゲートで(挙動不変・回帰テスト対象)
    commands.push({
      name: 'smoke',
      command: `npm run build && npx electron . --tool ${opts.toolName}${
        opts.smokeInputPath ? ` --input "${opts.smokeInputPath}"` : ''
      }`,
      env: { MYCODEX_SMOKE: '1' },
    });
  } else {
    // renderer/core: build を独立ゲート化し、フルアプリ・スモーク起動で「起動不能」を昇格前に落とす。
    // --smoke-boot は単一インスタンスロック非取得(MYCODEX_SMOKE配下)+userData隔離(index.ts側)
    commands.push({ name: 'build', command: 'npm run build' });
    commands.push({
      name: 'smoke',
      command: 'npx electron . --smoke-boot',
      env: { MYCODEX_SMOKE: '1' },
    });
  }

  for (const c of commands) {
    const { code, output } = await run(c.command, opts.worktreeDir, c.env);
    const ok = code === 0;
    results.push({ name: c.name, ok, detail: ok ? '合格' : output.slice(-2000) });
    if (!ok) return fail();
  }

  return { ok: true, results };
}
