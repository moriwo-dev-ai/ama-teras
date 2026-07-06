import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvolutionEvent } from '../../shared/types';
import { runGit } from './git';
import type { EvolutionJobRunner, JobArtifacts } from './job';
import { EvolutionManager, type EvolutionManagerDeps } from './manager';

/**
 * M20: renderer/core スコープの昇格フロー(再ビルド+健全性→再起動要求 / 失敗→自動revert)。
 * 実git統合。runCommand と rebuildAndHealthBoot はモック注入。
 */

let base: string;
let repoDir: string;

async function initRepo(): Promise<void> {
  base = await mkdtemp(join(tmpdir(), 'amateras-evo-core-'));
  repoDir = join(base, 'repo');
  await mkdir(repoDir, { recursive: true });
  await runGit(['init', '-b', 'main'], repoDir);
  await runGit(['config', 'user.name', 'test'], repoDir);
  await runGit(['config', 'user.email', 'test@example.com'], repoDir);
  await mkdir(join(repoDir, 'src/renderer/src'), { recursive: true });
  await mkdir(join(repoDir, 'src/main/core'), { recursive: true });
  await writeFile(join(repoDir, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(repoDir, 'src/renderer/src/App.tsx'), '// app');
  await writeFile(join(repoDir, 'src/main/core/service.ts'), '// service');
  await runGit(['add', '-A'], repoDir);
  await runGit(['commit', '-m', 'init'], repoDir);
}

beforeEach(async () => {
  await initRepo();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

function scriptedRunner(files: Record<string, string>, artifacts: JobArtifacts): EvolutionJobRunner {
  return {
    async generate(_req, worktreeDir) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(worktreeDir, rel);
        await mkdir(join(abs, '..'), { recursive: true });
        await writeFile(abs, content);
      }
      return artifacts;
    },
  };
}

interface Overrides {
  runner?: EvolutionJobRunner;
  approve?: boolean;
  healthOk?: boolean;
  rebuildAndHealthBoot?: EvolutionManagerDeps['rebuildAndHealthBoot'];
}

function makeManager(o: Overrides = {}): {
  manager: EvolutionManager;
  events: EvolutionEvent[];
  restarts: { tag: string; prevCommit: string }[];
  rebuildCalls: string[];
  approvals: number;
} {
  const events: EvolutionEvent[] = [];
  const restarts: { tag: string; prevCommit: string }[] = [];
  const rebuildCalls: string[] = [];
  const state = { approvals: 0 };
  const deps: EvolutionManagerDeps = {
    repoDir,
    worktreeBase: join(base, 'evolve'),
    runner:
      o.runner ??
      scriptedRunner({ 'src/renderer/src/NewWidget.tsx': '// widget' }, { summary: 'UI改善' }),
    requestPromotionApproval: async () => {
      state.approvals += 1;
      return o.approve ?? true;
    },
    reloadPlugins: async () => {},
    healthCheck: async () => true,
    rebuildAndHealthBoot:
      o.rebuildAndHealthBoot ??
      (async () => {
        rebuildCalls.push('health');
        return (o.healthOk ?? true)
          ? { ok: true, output: 'ok' }
          : { ok: false, output: 'boot fail' };
      }),
    requestRestart: (tag, prevCommit) => restarts.push({ tag, prevCommit }),
    onEvent: (e) => events.push(e),
    runCommand: async (cmd) => {
      rebuildCalls.push(cmd);
      return { code: 0, output: 'ok' };
    },
  };
  const manager = new EvolutionManager(deps);
  return { manager, events, restarts, rebuildCalls, approvals: state.approvals, ...{} } as never;
}

function lastJob(events: EvolutionEvent[]): { status: string; scope?: string; requiresRestart?: boolean; error?: string } {
  const updates = events.filter((e) => e.kind === 'job_update');
  return (updates.at(-1) as { job: { status: string } }).job as never;
}

async function waitForTerminal(events: EvolutionEvent[], timeoutMs = 30_000): Promise<string> {
  const terminal = ['done', 'failed', 'rejected', 'rolled_back'];
  const start = Date.now();
  for (;;) {
    const updates = events.filter((e) => e.kind === 'job_update');
    const s = updates.length > 0 ? (updates.at(-1) as { job: { status: string } }).job.status : undefined;
    if (s && terminal.includes(s)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`タイムアウト(最終status: ${s})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('M20: renderer/core 昇格フロー(実git統合)', { timeout: 30_000 }, () => {
  it('renderer正常系: ゲート→承認→マージ+タグ→再ビルド健全性→再起動要求→done', async () => {
    const ctx = makeManager();
    await ctx.manager.enqueue({ description: 'UI改善', expectedIO: '-', scope: 'renderer' });
    const status = await waitForTerminal(ctx.events);
    expect(status).toBe('done');

    const job = lastJob(ctx.events);
    expect(job.scope).toBe('renderer');
    expect(job.requiresRestart).toBe(true);
    // 再起動要求がタグ+昇格前HEADつきで呼ばれた
    expect(ctx.restarts).toHaveLength(1);
    expect(ctx.restarts[0]!.tag).toMatch(/^evolve\/\d+$/);
    expect(ctx.restarts[0]!.prevCommit).toMatch(/^[0-9a-f]{40}$/);
    // マージ+タグが存在し、生成物がmainに載っている
    expect(await runGit(['tag', '-l', 'evolve/*'], repoDir)).not.toBe('');
    const widget = await runGit(['show', 'HEAD:src/renderer/src/NewWidget.tsx'], repoDir);
    expect(widget).toBe('// widget');
  });

  it('健全性チェック失敗: 自動revert+旧バンドル再ビルド→rolled_back(再起動しない)', async () => {
    const ctx = makeManager({ healthOk: false });
    await ctx.manager.enqueue({ description: 'UI改善', expectedIO: '-', scope: 'renderer' });
    const status = await waitForTerminal(ctx.events);
    expect(status).toBe('rolled_back');
    expect(ctx.restarts).toHaveLength(0); // 再起動要求は出ない
    // revert済み: 生成物はHEADに存在しない
    await expect(runGit(['show', 'HEAD:src/renderer/src/NewWidget.tsx'], repoDir)).rejects.toThrow();
    // 旧バンドル復元の再ビルドが走った(health → revert後の npm run build)
    expect(ctx.rebuildCalls.filter((c) => c === 'npm run build').length).toBeGreaterThanOrEqual(1);
  });

  it('rebuildAndHealthBoot未注入なら昇格を取り消して失敗(配線漏れの安全側)', async () => {
    const ctx = makeManager({ rebuildAndHealthBoot: undefined });
    // makeManagerの既定を上書きして未注入をシミュレート
    const deps = (ctx.manager as unknown as { deps: EvolutionManagerDeps }).deps;
    delete (deps as { rebuildAndHealthBoot?: unknown }).rebuildAndHealthBoot;
    await ctx.manager.enqueue({ description: 'UI改善', expectedIO: '-', scope: 'renderer' });
    const status = await waitForTerminal(ctx.events);
    expect(status).toBe('failed');
    expect(lastJob(ctx.events).error).toContain('配線漏れ');
    await expect(runGit(['show', 'HEAD:src/renderer/src/NewWidget.tsx'], repoDir)).rejects.toThrow();
  });

  it('rendererスコープでsrc/main(core領域)を触るとallowlistで不合格→再生成→failed', async () => {
    const ctx = makeManager({
      runner: scriptedRunner(
        {
          'src/renderer/src/NewWidget.tsx': '// widget',
          'src/main/core/service.ts': '// 越境!',
        },
        { summary: 'x' },
      ),
    });
    await ctx.manager.enqueue({ description: 'x', expectedIO: '-', scope: 'renderer' });
    const status = await waitForTerminal(ctx.events);
    expect(status).toBe('failed');
    expect(ctx.restarts).toHaveLength(0);
    expect(await runGit(['tag', '-l', 'evolve/*'], repoDir)).toBe('');
  });

  it('coreスコープ: src/main の聖域外は通り done になる', async () => {
    const ok = makeManager({
      runner: scriptedRunner({ 'src/main/core/newFeature.ts': '// feature' }, { summary: 'core' }),
    });
    await ok.manager.enqueue({ description: 'core改善', expectedIO: '-', scope: 'core' });
    expect(await waitForTerminal(ok.events)).toBe('done');
    expect(lastJob(ok.events).scope).toBe('core');
  });

  it('coreスコープでも聖域(secrets.ts の新規設置含む)は protected で即reject', async () => {
    // 聖域パスへの「新規ファイル追加」も差分として捕捉される(既存ファイルである必要はない)
    const bad = makeManager({
      runner: scriptedRunner({ 'src/main/secrets.ts': '// 鍵を盗む' }, { summary: 'x' }),
    });
    await bad.manager.enqueue({ description: 'x', expectedIO: '-', scope: 'core' });
    const status = await waitForTerminal(bad.events);
    expect(status).toBe('rejected');
    const job = lastJob(bad.events) as { protectedReject?: boolean };
    expect(job.protectedReject).toBe(true);
  });

  it('回帰: scope未指定(tool)は従来どおりホットリロード経路(再起動要求なし)', async () => {
    const ctx = makeManager({
      runner: scriptedRunner(
        { 'src/main/tools/plugins/x.ts': '// plugin' },
        { toolName: 'x', smokeInput: {} },
      ),
    });
    // tool用のディレクトリを用意
    await mkdir(join(repoDir, 'src/main/tools/plugins'), { recursive: true });
    await writeFile(join(repoDir, 'src/main/tools/plugins/.gitkeep'), '');
    await runGit(['add', '-A'], repoDir);
    await runGit(['commit', '-m', 'plugins dir'], repoDir);

    await ctx.manager.enqueue({ description: 'tool', expectedIO: '-' });
    const status = await waitForTerminal(ctx.events);
    expect(status).toBe('done');
    expect(ctx.restarts).toHaveLength(0); // toolは再起動しない
    expect(lastJob(ctx.events).requiresRestart).toBe(false);
  });
});
