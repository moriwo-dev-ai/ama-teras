import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runGates } from './gates';
import { inferScope, SCOPE_ALLOWLISTS, scopeRequiresRestart, stricterScope } from './scopes';

/** M20-2: スコープ段階化とゲート順序・--smoke-boot 不変条件の固定 */

describe('SCOPE_ALLOWLISTS(段階的書き込み許可)', () => {
  it('tool は従来どおり plugins のみ / renderer は src/renderer のみ(sharedを含めない)', () => {
    expect(SCOPE_ALLOWLISTS.tool).toEqual(['src/main/tools/plugins']);
    expect(SCOPE_ALLOWLISTS.renderer).toEqual(['src/renderer']);
    expect(SCOPE_ALLOWLISTS.renderer).not.toContain('src/shared');
    expect(SCOPE_ALLOWLISTS.core).toEqual(['src/main', 'src/shared', 'src/renderer']);
  });

  it('inferScope は最小内包スコープを返し、stricterScope は厳しい側を採用する', () => {
    expect(inferScope(['src/main/tools/plugins/a.ts'])).toBe('tool');
    expect(inferScope(['src/renderer/src/App.tsx'])).toBe('renderer');
    expect(inferScope(['src/renderer/src/App.tsx', 'src/main/core/service.ts'])).toBe('core');
    expect(inferScope(['src/shared/types.ts'])).toBe('core'); // sharedはcore
    expect(stricterScope('tool', 'core')).toBe('core');
    expect(stricterScope('renderer', 'tool')).toBe('renderer');
  });

  it('renderer/core は再起動必須、tool は不要', () => {
    expect(scopeRequiresRestart('tool')).toBe(false);
    expect(scopeRequiresRestart('renderer')).toBe(true);
    expect(scopeRequiresRestart('core')).toBe(true);
  });
});

describe('runGates のスコープ別コマンド(runCommandモック)', () => {
  // protected/danger/allowlist ゲートは実gitを使うため、ここでは git を経由しない検証だけを行い、
  // ゲート順序の結合検証は manager.test(実git)と protected.test が担う。
  it("scope='tool' で toolName 欠落は即例外(コマンド未実行)", async () => {
    const runCommand = vi.fn(async () => ({ code: 0, output: '' }));
    await expect(
      runGates({
        repoDir: '/nonexistent',
        worktreeDir: '/nonexistent',
        branch: 'b',
        baseRef: 'main',
        allowedPaths: SCOPE_ALLOWLISTS.tool,
        runCommand,
      }),
    ).rejects.toThrow(/toolName/);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('【不変条件2】--smoke-boot のロック非取得+userData隔離(ソース・トリップワイヤ)', () => {
  const indexSource = (): string =>
    readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

  it('--smoke-boot は AMATERAS_SMOKE 配下でのみ有効(=単一インスタンスロックのスキップに乗る)', () => {
    const src = indexSource();
    expect(src).toContain("smokeMode && process.argv.includes('--smoke-boot')");
    // ロック取得式は M12-0 のまま不変(smokeMode で必ずスキップ)
    expect(src).toContain('smokeMode ? true : app.requestSingleInstanceLock()');
  });

  it('--smoke-boot は userData を mkdtemp で隔離してから起動する', () => {
    const src = indexSource();
    const smokeBootIdx = src.indexOf('if (smokeBoot) {');
    const setPathIdx = src.indexOf("app.setPath('userData', mkdtempSync(");
    expect(smokeBootIdx).toBeGreaterThanOrEqual(0);
    expect(setPathIdx).toBeGreaterThan(smokeBootIdx);
    // whenReady より前に隔離される(位置関係で固定)
    expect(setPathIdx).toBeLessThan(src.indexOf('app.whenReady()'));
  });

  it('gates の renderer/core スモークは --smoke-boot + AMATERAS_SMOKE で起動する(ソース固定)', () => {
    const src = readFileSync(fileURLToPath(new URL('./gates.ts', import.meta.url)), 'utf8');
    expect(src).toContain("command: 'npx electron . --smoke-boot'");
    expect(src).toContain("env: { AMATERAS_SMOKE: '1' }");
  });
});
