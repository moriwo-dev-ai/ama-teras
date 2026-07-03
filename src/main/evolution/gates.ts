import { spawn } from 'node:child_process';
import type { EvolutionGateResult } from '../../shared/types';
import { runGit } from './git';

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
  /** B(worktree)。typecheck/vitest/smokeの実行場所 */
  worktreeDir: string;
  branch: string;
  baseRef: string;
  /** 進化ジョブが変更してよいパス接頭辞(リポジトリルート相対、/区切り) */
  allowedPaths: string[];
  /** スモーク対象の新ツール */
  toolName: string;
  /** スモーク入力JSONファイル(B内の絶対パス)。省略時は入力なし */
  smokeInputPath?: string;
  runCommand?: CommandRunner;
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
 * 順序: 差分検査 → typecheck → vitest → build+スモーク。
 * 差分検査を最初に置くのは、保護領域を書き換えた生成コードを
 * 後続ゲート(=コード実行を伴う)で走らせる前に落とすため。
 */
export async function runGates(opts: GateOptions): Promise<GatesOutcome> {
  const run = opts.runCommand ?? defaultRunCommand;
  const results: EvolutionGateResult[] = [];
  const fail = (): GatesOutcome => ({ ok: false, results });

  results.push(await checkDiffAllowlist(opts.repoDir, opts.baseRef, opts.branch, opts.allowedPaths));
  if (!results[0]!.ok) return fail();

  const commands: { name: string; command: string; env?: Record<string, string> }[] = [
    { name: 'typecheck', command: 'npm run typecheck' },
    { name: 'vitest', command: 'npx vitest run' },
    {
      name: 'smoke',
      command: `npm run build && npx electron . --tool ${opts.toolName}${
        opts.smokeInputPath ? ` --input "${opts.smokeInputPath}"` : ''
      }`,
      env: { MYCODEX_SMOKE: '1' },
    },
  ];

  for (const c of commands) {
    const { code, output } = await run(c.command, opts.worktreeDir, c.env);
    const ok = code === 0;
    results.push({ name: c.name, ok, detail: ok ? '合格' : output.slice(-2000) });
    if (!ok) return fail();
  }

  return { ok: true, results };
}
