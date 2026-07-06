import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { runGit } from './git';
import { checkProtectedTripwire, isProtectedFile, PROTECTED_PATHS } from './protected';

/**
 * M20-1【最重要・TDD】: 聖域(保護領域)トリップワイヤの固定。
 * 不変条件(ユーザー承認済み・2026-07-06):
 * 1. 判定は稼働中A側のメモリ上 PROTECTED_PATHS 定数のみで行う。
 *    worktree B側の protected.ts を require/import して判定に使うことを絶対に禁止。
 *    → 「Bの protected.ts を空にしても、A側リストの src/main/evolution エントリで捕捉される」
 * 2. 聖域への差分は検証以前に必ず reject(承認ダイアログにも出さない — manager側で固定)
 * 3. PROTECTED_PATHS を減らす・無効化する差分も reject(自己参照ガード)
 */

// ---- ユニット: isProtectedFile ----

describe('isProtectedFile(パス判定)', () => {
  it('聖域の各エントリ配下のファイルを捕捉する', () => {
    const cases: [string, string][] = [
      ['src/main/evolution/manager.ts', 'src/main/evolution'],
      ['src/main/evolution/protected.ts', 'src/main/evolution'], // 自己参照
      ['src/main/evolution/guardrails.test.ts', 'src/main/evolution'], // テストも聖域
      ['src/main/agent/approval.ts', 'src/main/agent/approval.ts'],
      ['src/renderer/src/components/Approval/ApprovalDialog.tsx', 'src/renderer/src/components/Approval'],
      ['src/main/ipc.ts', 'src/main/ipc.ts'],
      ['src/preload/index.ts', 'src/preload'],
      ['src/shared/ipc.ts', 'src/shared/ipc.ts'],
      ['src/main/secrets.ts', 'src/main/secrets.ts'],
      ['src/main/userDataMigration.ts', 'src/main/userDataMigration.ts'],
      ['CLAUDE.md', 'CLAUDE.md'],
      ['docs/PROTECTED.md', 'docs/PROTECTED.md'],
    ];
    for (const [file, expected] of cases) {
      expect(isProtectedFile(file), file).toBe(expected);
    }
  });

  it('聖域外は null(plugins / renderer通常部 / core通常部)', () => {
    for (const file of [
      'src/main/tools/plugins/new_tool.ts',
      'src/renderer/src/components/Chat/ChatView.tsx',
      'src/main/core/service.ts',
      'src/main/agent/loop.ts',
      'src/shared/types.ts',
      'README.md',
    ]) {
      expect(isProtectedFile(file), file).toBeNull();
    }
  });

  it('紛らわしい兄弟パスに誤マッチしない(prefix境界)', () => {
    expect(isProtectedFile('src/main/evolutionX.ts')).toBeNull();
    expect(isProtectedFile('src/main/evolution.backup/x.ts')).toBeNull();
    expect(isProtectedFile('src/main/ipc.test.ts')).toBeNull(); // ipc.ts の完全一致のみ
    expect(isProtectedFile('src/preloader/x.ts')).toBeNull();
  });

  it('表記ゆれ(大文字小文字・バックスラッシュ・./)でも捕捉する', () => {
    expect(isProtectedFile('SRC/MAIN/Evolution/manager.ts')).toBe('src/main/evolution');
    expect(isProtectedFile('src\\main\\secrets.ts')).toBe('src/main/secrets.ts');
    expect(isProtectedFile('./CLAUDE.md')).toBe('CLAUDE.md');
  });
});

// ---- 自己参照ガード(ソース・トリップワイヤ) ----

describe('自己参照ガード', () => {
  const source = (): string =>
    readFileSync(fileURLToPath(new URL('./protected.ts', import.meta.url)), 'utf8');

  it('PROTECTED_PATHS は聖域の全カテゴリを含む(削除したらこのテストが落ちる)', () => {
    for (const required of [
      'src/main/evolution',
      'src/main/agent/approval.ts',
      'src/renderer/src/components/Approval',
      'src/main/ipc.ts',
      'src/preload',
      'src/shared/ipc.ts',
      'src/main/secrets.ts',
      'src/main/userDataMigration.ts',
      'CLAUDE.md',
      'docs/PROTECTED.md',
    ]) {
      expect(PROTECTED_PATHS).toContain(required);
    }
  });

  it('protected.ts は動的import/requireを一切持たない(B側コードを読み込む経路の禁止)', () => {
    const src = source();
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/); // 動的import
    // 不変条件のコメントが明記されていること
    expect(src).toContain('A側のメモリ上');
  });

  it('docs/PROTECTED.md と PROTECTED_PATHS が同期している(全エントリが文書に記載)', () => {
    const evolutionDir = fileURLToPath(new URL('.', import.meta.url));
    const doc = readFileSync(join(evolutionDir, '..', '..', '..', 'docs', 'PROTECTED.md'), 'utf8');
    for (const p of PROTECTED_PATHS) {
      expect(doc, `docs/PROTECTED.md に ${p} の記載がない`).toContain(p);
    }
  });
});

// ---- 結合: 実tempリポジトリでのトリップワイヤ ----

let repo: string;

/** テスト用リポジトリ: 聖域・聖域外のダミーツリーを main に持つ */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'amateras-protected-'));
  await runGit(['init', '-b', 'main'], dir);
  await runGit(['config', 'user.email', 't@t'], dir);
  await runGit(['config', 'user.name', 't'], dir);
  const seed: [string, string][] = [
    ['src/main/evolution/protected.ts', 'export const PROTECTED_PATHS = ["本物のリスト"];'],
    ['src/main/evolution/manager.ts', '// manager'],
    ['src/main/agent/approval.ts', '// broker'],
    ['src/renderer/src/components/Approval/ApprovalDialog.tsx', '// dialog'],
    ['src/renderer/src/components/Chat/ChatView.tsx', '// chat'],
    ['src/main/ipc.ts', '// ipc'],
    ['src/preload/index.ts', '// preload'],
    ['src/shared/ipc.ts', '// shared ipc'],
    ['src/main/secrets.ts', '// secrets'],
    ['src/main/userDataMigration.ts', '// migration'],
    ['src/main/core/service.ts', '// service'],
    ['src/main/tools/plugins/echo.ts', '// plugin'],
    ['CLAUDE.md', '# 規約'],
    ['docs/PROTECTED.md', '# 聖域'],
  ];
  for (const [file, content] of seed) {
    await mkdir(join(dir, dirname(file)), { recursive: true });
    await writeFile(join(dir, file), content, 'utf8');
  }
  await runGit(['add', '-A'], dir);
  await runGit(['commit', '-m', 'base'], dir);
  return dir;
}

/** branch を作って1ファイル変更をコミットする */
async function branchWithChange(
  name: string,
  file: string,
  content: string,
): Promise<string> {
  await runGit(['checkout', '-b', name, 'main'], repo);
  await mkdir(join(repo, dirname(file)), { recursive: true });
  await writeFile(join(repo, file), content, 'utf8');
  await runGit(['add', '-A'], repo);
  await runGit(['commit', '-m', name], repo);
  await runGit(['checkout', 'main'], repo);
  return name;
}

beforeAll(async () => {
  repo = await initRepo();
}, 30_000);

afterAll(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

// Windows では git プロセス起動が遅く、並列負荷で既定5sを超える(既存manager.testと同様)
describe('checkProtectedTripwire(実gitリポジトリ)', { timeout: 60_000 }, () => {
  it('聖域の各エントリへの変更が必ず reject される', async () => {
    const targets: [string, string][] = [
      ['t-evo', 'src/main/evolution/manager.ts'],
      ['t-approval', 'src/main/agent/approval.ts'],
      ['t-dialog', 'src/renderer/src/components/Approval/ApprovalDialog.tsx'],
      ['t-ipc', 'src/main/ipc.ts'],
      ['t-preload', 'src/preload/index.ts'],
      ['t-sharedipc', 'src/shared/ipc.ts'],
      ['t-secrets', 'src/main/secrets.ts'],
      ['t-migration', 'src/main/userDataMigration.ts'],
      ['t-claude', 'CLAUDE.md'],
      ['t-protectedmd', 'docs/PROTECTED.md'],
    ];
    for (const [branch, file] of targets) {
      await branchWithChange(branch, file, '// 書き換え');
      const r = await checkProtectedTripwire(repo, 'main', branch);
      expect(r.ok, `${file} が reject されていない`).toBe(false);
      expect(r.name).toBe('protected');
      expect(r.detail).toContain(file);
    }
  }, 60_000);

  it('【不変条件1の実証】B側の protected.ts を空リストに書き換えても、A側リストで捕捉される', async () => {
    // worktree(B)相当のブランチで protected.ts を「聖域なし」に改竄する。
    // 判定はこのプロセス(A)にimport済みの PROTECTED_PATHS 定数で行われるため、
    // Bの中身がどうであれ src/main/evolution エントリで必ず reject される
    await branchWithChange(
      't-self-disarm',
      'src/main/evolution/protected.ts',
      'export const PROTECTED_PATHS = [];',
    );
    const r = await checkProtectedTripwire(repo, 'main', 't-self-disarm');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('src/main/evolution/protected.ts');
  });

  it('聖域外のみの変更は pass する', async () => {
    await branchWithChange('t-ok-plugin', 'src/main/tools/plugins/new_tool.ts', '// new');
    const r1 = await checkProtectedTripwire(repo, 'main', 't-ok-plugin');
    expect(r1.ok).toBe(true);

    await branchWithChange('t-ok-renderer', 'src/renderer/src/components/Chat/New.tsx', '// ui');
    const r2 = await checkProtectedTripwire(repo, 'main', 't-ok-renderer');
    expect(r2.ok).toBe(true);
  });

  it('聖域ファイルを聖域外へ git mv しても(旧パスの削除として)reject される', async () => {
    await runGit(['checkout', '-b', 't-rename', 'main'], repo);
    await runGit(['mv', 'src/main/secrets.ts', 'src/main/core/notsecret.ts'], repo);
    await runGit(['commit', '-m', 'rename'], repo);
    await runGit(['checkout', 'main'], repo);
    const r = await checkProtectedTripwire(repo, 'main', 't-rename');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('src/main/secrets.ts');
  });

  it('シンボリックリンクの新規追加は内容に関わらず reject される(実体迂回の禁止)', async () => {
    // Windowsで実FSリンクを作らず、git plumbing で mode 120000 のエントリを作る
    await runGit(['checkout', '-b', 't-symlink', 'main'], repo);
    const target = join(repo, 'linktarget.txt');
    await writeFile(target, 'src/main/evolution/protected.ts', 'utf8');
    const blob = await runGit(['hash-object', '-w', target], repo);
    await runGit(
      ['update-index', '--add', '--cacheinfo', `120000,${blob},src/renderer/sneaky-link`],
      repo,
    );
    await runGit(['commit', '-m', 'symlink'], repo);
    await runGit(['checkout', 'main'], repo);
    await rm(target, { force: true });
    const r = await checkProtectedTripwire(repo, 'main', 't-symlink');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('シンボリックリンク');
  });

  it('変更ゼロのブランチは pass(空diffはallowlist側の担当)', async () => {
    await runGit(['checkout', '-b', 't-empty', 'main'], repo);
    await runGit(['commit', '--allow-empty', '-m', 'empty'], repo);
    await runGit(['checkout', 'main'], repo);
    const r = await checkProtectedTripwire(repo, 'main', 't-empty');
    expect(r.ok).toBe(true);
  });
});
