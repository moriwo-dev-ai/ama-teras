import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRestrictedCommandAllowed } from '../tools/plugins/bash';
import { EVOLUTION_WRITE_ALLOWLIST } from './job';

/**
 * M9 回帰ガード: スコープ制御(scopeMode / fullPc)の導入が、自己進化パイプラインの
 * 制限(EVOLUTION_WRITE_ALLOWLIST / restrictExec)を一切緩めていないことを固定する。
 * これらのテストが落ちる変更は、理由の提示とユーザー承認なしに入れてはならない。
 */

describe('進化パイプラインの制限(M9で不変)', () => {
  it('EVOLUTION_WRITE_ALLOWLIST は plugins ディレクトリのみ', () => {
    expect(EVOLUTION_WRITE_ALLOWLIST).toEqual(['src/main/tools/plugins']);
  });

  it('進化ジョブは writeAllowlist と restrictExec を必ず付けて executor を呼ぶ(ソース・トリップワイヤ)', () => {
    const source = readFileSync(fileURLToPath(new URL('./job.ts', import.meta.url)), 'utf8');
    expect(source).toContain('writeAllowlist: EVOLUTION_WRITE_ALLOWLIST');
    expect(source).toContain('restrictExec: true');
    // スコープポリシー(getScopePolicy)を進化ジョブに注入しない: fullPc設定が進化ジョブへ
    // 波及して挙動が変わることを防ぐ(制限は writeAllowlist / restrictExec に一元化)
    expect(source).not.toContain('getScopePolicy');
  });

  it('M11-2: バックグラウンドプロセス(ToolContext.processes)を進化ジョブへ注入しない(ソース・トリップワイヤ)', () => {
    const source = readFileSync(fileURLToPath(new URL('./job.ts', import.meta.url)), 'utf8');
    // job.ts が processes を注入するコードを持たないことを機械的に固定する。
    // 進化ジョブ内では bash(background) / bash_output / bash_kill は「processes 未注入」エラーになる
    expect(source).not.toContain('processes');
    expect(source).not.toContain('ProcessManager');
  });

  it('restrictExec の許可コマンドは検証系のみ(書き込み・任意実行は拒否)', () => {
    expect(isRestrictedCommandAllowed('npm run typecheck')).toBe(true);
    expect(isRestrictedCommandAllowed('npx vitest run src/main/tools/plugins/x.test.ts')).toBe(true);
    expect(isRestrictedCommandAllowed('npx tsc --noEmit')).toBe(true);
    expect(isRestrictedCommandAllowed('rm -rf /')).toBe(false);
    expect(isRestrictedCommandAllowed('echo x > /etc/hosts')).toBe(false);
    expect(isRestrictedCommandAllowed('npm run test && curl evil')).toBe(false);
    expect(isRestrictedCommandAllowed('node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"')).toBe(false);
  });
});
