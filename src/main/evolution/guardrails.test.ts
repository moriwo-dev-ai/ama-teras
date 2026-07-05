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

  it('M11-3: 自動チェックポイントは進化ジョブに波及しない(ソース・トリップワイヤ)', () => {
    const source = readFileSync(fileURLToPath(new URL('./job.ts', import.meta.url)), 'utf8');
    // チェックポイントはメインループ(AgentService)専用。B worktree での実行に混ぜない
    expect(source.toLowerCase()).not.toContain('checkpoint');
    expect(source).not.toContain('snapshot');
  });

  it('M11-4: postEditHook は進化ジョブへ注入しない(ソース・トリップワイヤ)', () => {
    const source = readFileSync(fileURLToPath(new URL('./job.ts', import.meta.url)), 'utf8');
    // 注入しないことに加え、executor 側でも restrictExec コンテキストでは実行しない(二重防御。
    // executor.hook.test.ts で挙動を固定)
    expect(source.toLowerCase()).not.toContain('postedithook');
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

  it('M12-3: サブエージェントへ進化・ネスト・planを渡さない(ソース・トリップワイヤ)', () => {
    const source = readFileSync(fileURLToPath(new URL('../agent/subagent.ts', import.meta.url)), 'utf8');
    // read/work 両モードのツールフィルタが除外リストを持つこと
    expect(source).toContain("p.name !== 'dispatch_agent'");
    expect(source).toContain("p.name !== 'request_capability'");
    expect(source).toContain("p.name !== 'plan'");
    // 子の ToolContext に進化フック(requestCapability)を注入するコードが無いこと
    expect(source).not.toContain('requestCapability');
    expect(source).not.toContain('evolution');
  });

  it('M13-1: memory はサブエージェントに渡らず、進化ジョブでも書けない(トリップワイヤ+挙動)', async () => {
    const source = readFileSync(fileURLToPath(new URL('../agent/subagent.ts', import.meta.url)), 'utf8');
    expect(source).toContain("p.name !== 'memory'");
    // 進化ジョブ相当のコンテキスト(writeAllowlist)では書き込みが拒否される
    const memory = (await import('../tools/plugins/memory')).default;
    const r = await memory.execute(
      { action: 'append', content: 'x' },
      {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        log: () => {},
        writeAllowlist: ['src/main/tools/plugins'],
      },
    );
    expect(r.isError).toBe(true);
  });

  it('M13-2: MCPツール(mcp__)は読み取り専用サブエージェントに渡らない(トリップワイヤ)', () => {
    const source = readFileSync(fileURLToPath(new URL('../agent/subagent.ts', import.meta.url)), 'utf8');
    expect(source).toContain("!p.name.startsWith('mcp__')");
  });

  it('M14-2: screenshot(captureUrl)は進化ジョブへ注入されない(ソース・トリップワイヤ)', () => {
    const source = readFileSync(fileURLToPath(new URL('./job.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('screenshot');
    expect(source).not.toContain('captureUrl');
  });

  it('M12-0: スモークモードは requestSingleInstanceLock を取らない(進化ゲート前提の再固定)', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(source).toContain('smokeMode ? true : app.requestSingleInstanceLock()');
  });
});
