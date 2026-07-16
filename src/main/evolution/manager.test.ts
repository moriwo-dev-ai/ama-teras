import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvolutionEvent } from '../../shared/types';
import { GenerationBudget } from './budget';
import { GenerationMetrics } from './metrics';
import { runGit } from './git';
import type { EvolutionJobRunner, JobArtifacts } from './job';
import { detectDangerWarnings, EvolutionManager, type EvolutionManagerDeps } from './manager';

const PLUGIN_SOURCE = `import type { ToolPlugin } from '../types';
export default {
  name: 'json_format',
  description: 'JSONを整形する',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() {
    return { content: 'formatted' };
  },
} satisfies ToolPlugin;
`;

let base: string;
let repoDir: string;

async function initRepo(): Promise<void> {
  base = await mkdtemp(join(tmpdir(), 'amateras-evo-'));
  repoDir = join(base, 'repo');
  await mkdir(repoDir, { recursive: true });
  await runGit(['init', '-b', 'main'], repoDir);
  await runGit(['config', 'user.name', 'test'], repoDir);
  await runGit(['config', 'user.email', 'test@example.com'], repoDir);
  await mkdir(join(repoDir, 'src/main/tools/plugins'), { recursive: true });
  await mkdir(join(repoDir, 'src/main/evolution'), { recursive: true });
  await writeFile(join(repoDir, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(repoDir, 'src/main/tools/plugins/.gitkeep'), '');
  await writeFile(join(repoDir, 'src/main/evolution/core.ts'), '// 保護領域');
  await runGit(['add', '-A'], repoDir);
  await runGit(['commit', '-m', 'init'], repoDir);
}

beforeEach(async () => {
  await initRepo();
});

afterEach(async () => {
  // Windows: git子プロセスの残ハンドルで EPERM になることがある(全体実行時のフレーク) → リトライ付き
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** worktree内に固定生成物を書くモックランナー */
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
  healthy?: boolean;
  runCommand?: EvolutionManagerDeps['runCommand'];
  existingToolNames?: EvolutionManagerDeps['existingToolNames'];
  // M92-A2: 本番既定は4だが、テストは歴史的に「2回で失敗」を前提にしているので既定2に固定する
  maxGenerationAttempts?: number;
  budget?: EvolutionManagerDeps['budget'];
  estimateAttemptTokens?: number;
  metrics?: EvolutionManagerDeps['metrics'];
  maxConcurrency?: number;
}

function makeManager(o: Overrides = {}): {
  manager: EvolutionManager;
  events: EvolutionEvent[];
  reloads: { count: number };
  approvals: { count: number };
} {
  const events: EvolutionEvent[] = [];
  const reloads = { count: 0 };
  const approvals = { count: 0 };
  const deps: EvolutionManagerDeps = {
    repoDir,
    worktreeBase: join(base, 'evolve'),
    runner:
      o.runner ??
      scriptedRunner(
        { 'src/main/tools/plugins/json_format.ts': PLUGIN_SOURCE },
        { toolName: 'json_format', smokeInput: {} },
      ),
    requestPromotionApproval: async () => {
      approvals.count += 1;
      return o.approve ?? true;
    },
    reloadPlugins: async () => {
      reloads.count += 1;
    },
    healthCheck: async () => o.healthy ?? true,
    onEvent: (e) => events.push(e),
    // typecheck/vitest/smoke は既定で全成功扱い(差分検査だけ実gitで検証する)
    runCommand: o.runCommand ?? (async () => ({ code: 0, output: 'ok' })),
    ...(o.existingToolNames !== undefined ? { existingToolNames: o.existingToolNames } : {}),
    // M92-A2: テスト既定は2(従来の「2回で failed」前提を保つ)。本番既定は4
    maxGenerationAttempts: o.maxGenerationAttempts ?? 2,
    ...(o.budget !== undefined ? { budget: o.budget } : {}),
    ...(o.estimateAttemptTokens !== undefined ? { estimateAttemptTokens: o.estimateAttemptTokens } : {}),
    ...(o.metrics !== undefined ? { metrics: o.metrics } : {}),
    ...(o.maxConcurrency !== undefined ? { maxConcurrency: () => o.maxConcurrency! } : {}),
  };
  return { manager: new EvolutionManager(deps), events, reloads, approvals };
}

function lastStatus(events: EvolutionEvent[]): string | undefined {
  const updates = events.filter((e) => e.kind === 'job_update');
  return updates.at(-1)?.kind === 'job_update' ? (updates.at(-1) as { job: { status: string } }).job.status : undefined;
}

async function waitForTerminal(events: EvolutionEvent[], timeoutMs = 30_000): Promise<string> {
  const terminal = ['done', 'failed', 'rejected', 'rolled_back', 'cancelled'];
  const start = Date.now();
  for (;;) {
    const s = lastStatus(events);
    if (s && terminal.includes(s)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`タイムアウト(最終status: ${s})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Windows では git のプロセス起動が遅く、並列負荷で既定5sを超えることがある
describe('EvolutionManager(実git統合)', { timeout: 30_000 }, () => {
  it('正常系: 生成→ゲート→承認→mainへマージ+タグ→ホットリロード→done', async () => {
    const { manager, events, reloads } = makeManager();
    const jobId = await manager.enqueue({ description: 'JSON整形ツール', expectedIO: 'json in/out' });
    expect(jobId).toBe(1);

    const status = await waitForTerminal(events);
    expect(status).toBe('done');

    // mainに生成物がマージされている
    const files = await runGit(['ls-tree', '-r', '--name-only', 'main'], repoDir);
    expect(files).toContain('src/main/tools/plugins/json_format.ts');
    // タグ
    expect(await runGit(['tag', '-l', 'evolve/*'], repoDir)).toBe('evolve/1');
    // ホットリロードが呼ばれた
    expect(reloads.count).toBe(1);
    // worktreeとブランチは掃除済み
    expect(existsSync(join(base, 'evolve', 'job-1'))).toBe(false);
    expect(await runGit(['branch', '--list', 'evolve/job-1'], repoDir)).toBe('');
  });

  it('M20: 保護領域(聖域)への変更は protected ゲートで即reject(再生成なし・承認ダイアログなし)', async () => {
    let approvalRequested = false;
    const { manager, events } = makeManager({
      runner: scriptedRunner(
        {
          'src/main/tools/plugins/json_format.ts': PLUGIN_SOURCE,
          'src/main/evolution/core.ts': '// 改ざん!',
        },
        { toolName: 'json_format', smokeInput: {} },
      ),
    });
    // makeManager の approve は Promise を返す前に protected で落ちるため呼ばれないはず。
    // 明示的に監視して「承認ダイアログにすら出ない」を固定する
    const deps = (manager as unknown as { deps: EvolutionManagerDeps }).deps;
    const originalApproval = deps.requestPromotionApproval;
    deps.requestPromotionApproval = async (job, diff, warnings) => {
      approvalRequested = true;
      return originalApproval(job, diff, warnings);
    };

    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    const status = await waitForTerminal(events);
    expect(status).toBe('rejected');
    expect(approvalRequested).toBe(false);

    const updates = events.filter((e) => e.kind === 'job_update');
    const lastJob = (updates.at(-1) as { job: { gates: { name: string; ok: boolean; detail: string }[]; protectedReject?: boolean; error?: string } }).job;
    expect(lastJob.protectedReject).toBe(true);
    expect(lastJob.gates[0]).toMatchObject({ name: 'protected', ok: false });
    expect(lastJob.gates[0]!.detail).toContain('src/main/evolution/core.ts');
    // 再生成(2回目のgenerate)が走っていない: verifying→rejected が1回で終わる
    // mainは汚染されていない
    expect(await runGit(['tag', '-l', 'evolve/*'], repoDir)).toBe('');
    const core = await runGit(['show', 'main:src/main/evolution/core.ts'], repoDir);
    expect(core).toBe('// 保護領域');
  });

  it('承認却下で rejected、mainは変わらない', async () => {
    const { manager, events } = makeManager({ approve: false });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    const status = await waitForTerminal(events);
    expect(status).toBe('rejected');
    expect(await runGit(['tag', '-l', 'evolve/*'], repoDir)).toBe('');
    const files = await runGit(['ls-tree', '-r', '--name-only', 'main'], repoDir);
    expect(files).not.toContain('json_format');
  });

  it('健全性チェック失敗で自動revertされ rolled_back', async () => {
    const { manager, events, reloads } = makeManager({ healthy: false });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    const status = await waitForTerminal(events);
    expect(status).toBe('rolled_back');

    // revertによりmainのHEADには生成物が存在しない
    const files = await runGit(['ls-tree', '-r', '--name-only', 'main'], repoDir);
    expect(files).not.toContain('src/main/tools/plugins/json_format.ts');
    // マージ後とrevert後の2回リロード
    expect(reloads.count).toBe(2);
  });

  it('ジョブIDは既存タグから連番になる', async () => {
    const { manager, events } = makeManager();
    const id1 = await manager.enqueue({ description: '1', expectedIO: 'x' });
    await waitForTerminal(events);
    expect(id1).toBe(1);

    const m2 = makeManager();
    const id2 = await m2.manager.enqueue({ description: '2', expectedIO: 'x' });
    expect(id2).toBe(2);
    await waitForTerminal(m2.events);
  });
});

describe('再生成・リトライ', { timeout: 30_000 }, () => {
  it('ゲート不合格→フィードバック付き再生成→2回目で合格し昇格まで進む', async () => {
    const feedbacks: (string | undefined)[] = [];
    const runner: EvolutionJobRunner = {
      async generate(_req, worktreeDir, _log, _signal, feedback) {
        feedbacks.push(feedback);
        const marker = feedback ? 'GOOD' : 'BAD';
        await writeFile(
          join(worktreeDir, 'src/main/tools/plugins/json_format.ts'),
          PLUGIN_SOURCE.replace('formatted', marker),
        );
        return { toolName: 'json_format', smokeInput: {} };
      },
    };
    const events: EvolutionEvent[] = [];
    const deps: EvolutionManagerDeps = {
      repoDir,
      worktreeBase: join(base, 'evolve'),
      runner,
      requestPromotionApproval: async () => true,
      reloadPlugins: async () => {},
      healthCheck: async () => true,
      onEvent: (e) => events.push(e),
      // BADマーカーを含む生成物はtypecheckで落とす擬似ゲート
      runCommand: async (command, cwd) => {
        if (command.includes('typecheck')) {
          const { readFile } = await import('node:fs/promises');
          const src = await readFile(join(cwd, 'src/main/tools/plugins/json_format.ts'), 'utf8');
          if (src.includes('BAD')) return { code: 1, output: '型エラー: BAD' };
        }
        return { code: 0, output: 'ok' };
      },
    };
    const manager = new EvolutionManager(deps);
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    const status = await waitForTerminal(events);

    expect(status).toBe('done');
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain('typecheck');
    expect(feedbacks[1]).toContain('型エラー');
  });

  it('再生成でも不合格なら failed', async () => {
    const { manager, events } = makeManager({
      // 常にvitestで落ちる
      runCommand: async (command) =>
        command.includes('vitest') ? { code: 1, output: 'テスト失敗' } : { code: 0, output: 'ok' },
    });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    const status = await waitForTerminal(events);
    expect(status).toBe('failed');
  });

  it('生成の例外は1回リトライされ、2回目成功で継続する', async () => {
    let calls = 0;
    const runner: EvolutionJobRunner = {
      async generate(_req, worktreeDir) {
        calls += 1;
        if (calls === 1) throw new Error('一時的な生成失敗');
        await writeFile(join(worktreeDir, 'src/main/tools/plugins/json_format.ts'), PLUGIN_SOURCE);
        return { toolName: 'json_format', smokeInput: {} };
      },
    };
    const { manager, events } = makeManager({ runner });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    const status = await waitForTerminal(events);
    expect(status).toBe('done');
    expect(calls).toBe(2);
  });
});

describe('M92-A2/予算: 反復を厚く・累積キャップ', { timeout: 30_000 }, () => {
  it('A2: 2回を超えて粘れる(3回目のゲート合格で昇格する)', async () => {
    let vitestCalls = 0;
    const { manager, events } = makeManager({
      maxGenerationAttempts: 3,
      // vitest は最初の2回落ち、3回目で通る(以前の2回上限では failed になっていたケース)
      runCommand: async (command) => {
        if (command.includes('vitest')) {
          vitestCalls += 1;
          return vitestCalls < 3 ? { code: 1, output: 'テスト失敗' } : { code: 0, output: 'ok' };
        }
        return { code: 0, output: 'ok' };
      },
    });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    expect(await waitForTerminal(events)).toBe('done');
    expect(vitestCalls).toBe(3);
  });

  it('予算: セッション上限に達したら生成に入る前に打ち切る(Fable 5 枠の保護)', async () => {
    const budget = new GenerationBudget({ sessionTokens: 5_000 });
    budget.record(5_000); // 別ジョブで既に使い切っている想定
    const { manager, events } = makeManager({ budget, estimateAttemptTokens: 4_000 });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    expect(await waitForTerminal(events)).toBe('failed');
    const lastJob = events
      .filter((e): e is Extract<EvolutionEvent, { kind: 'job_update' }> => e.kind === 'job_update')
      .map((e) => e.job)
      .at(-1);
    expect(lastJob?.error).toContain('トークン上限');
  });

  it('Phase0: 昇格まで通ると promoted が記録される(試行回数・所要時間つき)', async () => {
    const metrics = new GenerationMetrics(join(base, 'metrics', 'gen.jsonl'));
    const { manager, events } = makeManager({ metrics });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    expect(await waitForTerminal(events)).toBe('done');
    const recs = metrics.read();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.outcome).toBe('promoted');
    expect(recs[0]?.attempts).toBeGreaterThanOrEqual(1);
    expect(metrics.summary().successRate).toBe(1);
  });
});

// Windows では git のプロセス起動が遅く、並列負荷で既定5sを超えることがある
describe('M25-8: 既存ツール修正パイプライン(targetTool)', { timeout: 30_000 }, () => {
  it('targetTool指定+生成結果のtoolNameが一致すれば通常どおり昇格する', async () => {
    const { manager, events } = makeManager({ existingToolNames: () => ['json_format'] });
    await manager.enqueue({ description: '修正', expectedIO: 'x', targetTool: 'json_format' });
    expect(await waitForTerminal(events)).toBe('done');
  });

  it('targetTool指定+生成結果のtoolNameが不一致 → フィードバック付き再生成→2回目で一致すれば昇格する', async () => {
    let calls = 0;
    const runner: EvolutionJobRunner = {
      async generate(_req, worktreeDir) {
        calls += 1;
        // 1回目はわざと別名で生成(取り違えを模擬)、2回目でtargetToolどおりに修正
        const name = calls === 1 ? 'wrong_name' : 'json_format';
        await writeFile(join(worktreeDir, `src/main/tools/plugins/${name}.ts`), PLUGIN_SOURCE.replace('json_format', name));
        return { toolName: name, smokeInput: {} };
      },
    };
    const { manager, events } = makeManager({ runner, existingToolNames: () => ['json_format'] });
    await manager.enqueue({ description: '修正', expectedIO: 'x', targetTool: 'json_format' });
    expect(await waitForTerminal(events)).toBe('done');
    expect(calls).toBe(2);
  });

  it('targetToolが実在しない既存ツール名だとworktreeも作らず即rejectされる', async () => {
    const { manager, events } = makeManager({ existingToolNames: () => ['json_format'] });
    const jobId = await manager.enqueue({ description: '修正', expectedIO: 'x', targetTool: 'nonexistent' });
    const status = await waitForTerminal(events);
    expect(status).toBe('rejected');
    // worktreeを作る前に弾かれている(無駄なB環境が残らない)
    expect(existsSync(join(base, 'evolve', `job-${jobId}`))).toBe(false);
  });

  it('targetTool未指定(新規のつもり)で既存ツール名と衝突すると、直らずfailedになる', async () => {
    // 既定のscriptedRunnerは常に'json_format'を返す(フィードバックを反映しないダムモック)ので、
    // 2回試行しても衝突が解消せずfailedになるはず
    const { manager, events } = makeManager({ existingToolNames: () => ['json_format'] });
    await manager.enqueue({ description: '新規のつもり', expectedIO: 'x' }); // targetTool省略
    const status = await waitForTerminal(events);
    expect(status).toBe('failed');
  });
});

// Windows では git のプロセス起動が遅く、並列負荷で既定5sを超えることがある
describe('M26-6: ジョブのキャンセル', { timeout: 30_000 }, () => {
  /** signal.abort で中断できるブロッキングランナー(release() で通常完了もできる) */
  function blockingRunner(): { runner: EvolutionJobRunner; started: () => boolean; release: () => void } {
    let startedFlag = false;
    let releaseFn: (() => void) | null = null;
    const runner: EvolutionJobRunner = {
      generate(_req, worktreeDir, _log, signal) {
        startedFlag = true;
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('生成が中断された'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('生成が中断された')), { once: true });
          releaseFn = () => {
            void writeFile(join(worktreeDir, 'src/main/tools/plugins/json_format.ts'), PLUGIN_SOURCE).then(() =>
              resolve({ toolName: 'json_format', smokeInput: {} }),
            );
          };
        });
      },
    };
    return { runner, started: () => startedFlag, release: () => releaseFn?.() };
  }

  async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor タイムアウト');
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  it('queued(未着手)のジョブはキューから除去され cancelled になる。先行ジョブは影響を受けない', async () => {
    const { runner, started, release } = blockingRunner();
    const { manager } = makeManager({ runner });
    const id1 = await manager.enqueue({ description: '先行', expectedIO: 'x' });
    const id2 = await manager.enqueue({ description: '後続(未着手)', expectedIO: 'x' });
    await waitFor(started); // 先行が generate に入った=後続はまだキュー

    expect(manager.cancel(id2)).toBe(true);
    const job2 = manager.list().find((j) => j.id === id2)!;
    expect(job2.status).toBe('cancelled');

    release(); // 先行は通常どおり完走する
    await waitFor(() => manager.list().find((j) => j.id === id1)?.status === 'done');
  });

  it('実行中(generating)のジョブは abort で中断され cancelled になり、worktreeも掃除される', async () => {
    const { runner, started } = blockingRunner();
    const { manager, events } = makeManager({ runner });
    const id = await manager.enqueue({ description: '実行中を止める', expectedIO: 'x' });
    await waitFor(started);

    expect(manager.cancel(id)).toBe(true);
    expect(await waitForTerminal(events)).toBe('cancelled');
    const job = manager.list().find((j) => j.id === id)!;
    expect(job.error).toContain('キャンセル');
    expect(existsSync(join(base, 'evolve', `job-${id}`))).toBe(false);
  });

  it('実行中ジョブをキャンセルしても、後続のキューは止まらず処理される', async () => {
    let calls = 0;
    let firstStarted = false;
    const runner: EvolutionJobRunner = {
      generate(_req, worktreeDir, _log, signal) {
        calls += 1;
        if (calls === 1) {
          firstStarted = true;
          // 1本目はabortされるまでブロック
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('中断')), { once: true });
          });
        }
        // 2本目以降は普通に成功
        return writeFile(join(worktreeDir, 'src/main/tools/plugins/json_format.ts'), PLUGIN_SOURCE).then(() => ({
          toolName: 'json_format',
          smokeInput: {},
        }));
      },
    };
    const { manager } = makeManager({ runner });
    const id1 = await manager.enqueue({ description: '中断される', expectedIO: 'x' });
    const id2 = await manager.enqueue({ description: '後続', expectedIO: 'x' });
    await waitFor(() => firstStarted);
    expect(manager.cancel(id1)).toBe(true);

    await waitFor(() => manager.list().find((j) => j.id === id2)?.status === 'done');
    expect(manager.list().find((j) => j.id === id1)?.status).toBe('cancelled');
  });

  it('完了済み・存在しないジョブのキャンセルは受理されない(false)', async () => {
    const { manager, events } = makeManager();
    const id = await manager.enqueue({ description: 'x', expectedIO: 'x' });
    await waitForTerminal(events);
    expect(manager.cancel(id)).toBe(false); // done
    expect(manager.cancel(999)).toBe(false); // 存在しない
  });
});

describe('detectDangerWarnings', () => {
  it('child_processとネットワークを検出する', () => {
    expect(detectDangerWarnings(`+import { spawn } from 'node:child_process';`)).toHaveLength(1);
    expect(detectDangerWarnings(`+const r = await fetch('https://x');`)).toHaveLength(1);
    expect(detectDangerWarnings(`+const a = 1;`)).toHaveLength(0);
  });
});

describe('M27-4: プラグインインポート(importFrom)の統合', () => {
  const MANIFEST = {
    name: 'hello_import',
    version: '1.0.0',
    pluginApiVersion: '^1',
    description: '挨拶する',
    author: 'someone',
    license: 'MIT',
    permissions: { network: false, childProcess: false, fsScope: 'none' },
    dependencies: [],
    smoke: { input: {} },
  };
  const IMPORT_PLUGIN = `import type { ToolPlugin } from '../types';
export default {
  name: 'hello_import',
  description: '挨拶する',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() { return { content: 'hello' }; },
} satisfies ToolPlugin;
`;

  async function makeImportDir(): Promise<string> {
    const dir = join(base, 'import-pkg');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
    await writeFile(join(dir, 'hello_import.ts'), IMPORT_PLUGIN);
    await writeFile(join(dir, 'hello_import.test.ts'), '// test');
    return dir;
  }

  it('検査→コピー→ゲート→承認→昇格まで既存パイプラインで完走する', async () => {
    const dir = await makeImportDir();
    const { composeRunners, ImportJobRunner } = await import('../registry/importRunner');
    const dummyGenerator = {
      generate: async () => {
        throw new Error('generatorは呼ばれないはず');
      },
    };
    const { manager, events, reloads } = makeManager({
      runner: composeRunners(dummyGenerator, new ImportJobRunner()),
    });
    await manager.enqueue({
      description: 'コミュニティプラグイン「hello_import」のインポート',
      expectedIO: '挨拶する',
      scope: 'tool',
      importFrom: dir,
    });
    const status = await waitForTerminal(events);
    expect(status).toBe('done');
    expect(reloads.count).toBeGreaterThan(0); // 昇格後のホットリロードが走った
    // インポートしたファイルが main ブランチへ昇格している
    const show = await runGit(['show', 'main:src/main/tools/plugins/hello_import.ts'], repoDir);
    expect(show).toContain('hello_import');
  });

  it('ゲート不合格のインポートは再生成せず failed になる(再コピーは無意味)', async () => {
    const dir = await makeImportDir();
    const { composeRunners, ImportJobRunner } = await import('../registry/importRunner');
    const dummyGenerator = { generate: async () => ({ toolName: 'x' }) };
    const { manager, events } = makeManager({
      runner: composeRunners(dummyGenerator, new ImportJobRunner()),
      // typecheck を落とす(検証ゲート不合格)
      runCommand: async (cmd) =>
        cmd.includes('typecheck') ? { code: 1, output: 'TS2304' } : { code: 0, output: 'ok' },
    });
    await manager.enqueue({
      description: 'インポート',
      expectedIO: 'x',
      scope: 'tool',
      importFrom: dir,
    });
    const status = await waitForTerminal(events);
    expect(status).toBe('failed');
  });
});

/** 特定ジョブが終端状態になるまで待つ(並列テスト用。全体の最終statusでは足りない) */
async function waitForJobTerminal(
  events: EvolutionEvent[],
  jobId: number,
  timeoutMs = 30_000,
): Promise<string> {
  const terminal = ['done', 'failed', 'rejected', 'rolled_back', 'cancelled'];
  const start = Date.now();
  for (;;) {
    const upd = events.filter(
      (e): e is Extract<EvolutionEvent, { kind: 'job_update' }> => e.kind === 'job_update' && e.job.id === jobId,
    );
    const s = upd.at(-1)?.job.status;
    if (s && terminal.includes(s)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`タイムアウト job ${jobId}: ${s}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 生成の並走をピーク在席数で観測できるランナー(ジョブごとに一意のツールを書く) */
function concurrencyProbeRunner(state: { active: number; peak: number }, holdMs: number): EvolutionJobRunner {
  return {
    async generate(req, worktreeDir): Promise<JobArtifacts> {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      await new Promise((r) => setTimeout(r, holdMs)); // 相手が入る余地を作る
      const name = `tool_${req.description.replace(/[^a-z0-9]/gi, '')}`;
      const abs = join(worktreeDir, `src/main/tools/plugins/${name}.ts`);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, PLUGIN_SOURCE.replace('json_format', name));
      state.active -= 1;
      return { toolName: name, smokeInput: {} };
    },
  };
}

describe('M92-A6 並列生成 + 昇格ミューテックス(実git)', { timeout: 40_000 }, () => {
  it('maxConcurrency=2 で2ジョブが並走生成し、昇格は直列で両方 done + 2タグ', async () => {
    const state = { active: 0, peak: 0 };
    const { manager, events } = makeManager({
      runner: concurrencyProbeRunner(state, 150),
      maxConcurrency: 2,
    });
    const id1 = await manager.enqueue({ description: 'alpha', expectedIO: 'x' });
    const id2 = await manager.enqueue({ description: 'beta', expectedIO: 'x' });
    const [s1, s2] = await Promise.all([
      waitForJobTerminal(events, id1),
      waitForJobTerminal(events, id2),
    ]);
    expect(s1).toBe('done');
    expect(s2).toBe('done');
    expect(state.peak).toBe(2); // 実際に並走した
    // 昇格ミューテックスが効き、2件の merge が積み上がった(直列マージ成功の証拠)
    const tags = (await runGit(['tag', '-l', 'evolve/*'], repoDir)).split('\n').filter(Boolean);
    expect(tags.length).toBe(2);
  });

  it('maxConcurrency 未指定(既定1)は完全直列(peak=1)', async () => {
    const state = { active: 0, peak: 0 };
    const { manager, events } = makeManager({ runner: concurrencyProbeRunner(state, 60) });
    const id1 = await manager.enqueue({ description: 'gamma', expectedIO: 'x' });
    const id2 = await manager.enqueue({ description: 'delta', expectedIO: 'x' });
    await Promise.all([waitForJobTerminal(events, id1), waitForJobTerminal(events, id2)]);
    expect(state.peak).toBe(1); // 従来どおり1本ずつ
  });
});

describe('M92-A6-2 夜間自動昇格(専用ブランチ・実git)', { timeout: 40_000 }, () => {
  it('auto=true は承認を出さず evolve/nightly へ積み、main は無変更・reloadもしない', async () => {
    const { manager, events, reloads, approvals } = makeManager();
    const mainBefore = (await runGit(['rev-parse', 'main'], repoDir)).trim();

    const id = await manager.enqueue({ description: 'nightly tool', expectedIO: 'x', auto: true });
    const status = await waitForJobTerminal(events, id);

    expect(status).toBe('done');
    expect(approvals.count).toBe(0); // 承認ダイアログは出ない
    expect(reloads.count).toBe(0); // A(稼働中)へは載せない

    // main は 1mm も動いていない
    const mainAfter = (await runGit(['rev-parse', 'main'], repoDir)).trim();
    expect(mainAfter).toBe(mainBefore);

    // evolve/nightly が出来ていて、main より 2 コミット先(生成コミット+マージ)にある
    const branches = await runGit(['branch', '--list', 'evolve/nightly'], repoDir);
    expect(branches.trim()).not.toBe('');
    const ahead = (await runGit(['rev-list', '--count', 'main..evolve/nightly'], repoDir)).trim();
    expect(Number(ahead)).toBeGreaterThanOrEqual(1);
    // タグ evolve/N は nightly 側のコミットに付く(main からは辿れない)
    const tag = (await runGit(['tag', '-l', `evolve/${id}`], repoDir)).trim();
    expect(tag).toBe(`evolve/${id}`);
    // ジョブ要約に積み先ブランチが載る
    const upd = events.filter(
      (e): e is Extract<EvolutionEvent, { kind: 'job_update' }> => e.kind === 'job_update' && e.job.id === id,
    );
    expect(upd.at(-1)?.job.autoBranch).toBe('evolve/nightly');
  });

  it('複数の auto ジョブは同じ evolve/nightly に積み上がる(直列マージ)', async () => {
    const { manager, events } = makeManager({ maxConcurrency: 2 });
    const id1 = await manager.enqueue({ description: 'nightly one', expectedIO: 'x', auto: true });
    const id2 = await manager.enqueue({ description: 'nightly two', expectedIO: 'x', auto: true });
    const [s1, s2] = await Promise.all([
      waitForJobTerminal(events, id1),
      waitForJobTerminal(events, id2),
    ]);
    expect(s1).toBe('done');
    expect(s2).toBe('done');
    // 2件とも nightly に載った(マージコミット2本 → main から 4 コミット先)
    const tags = (await runGit(['tag', '-l', 'evolve/*'], repoDir)).split('\n').filter(Boolean);
    expect(tags.length).toBe(2);
    const ahead = Number((await runGit(['rev-list', '--count', 'main..evolve/nightly'], repoDir)).trim());
    expect(ahead).toBeGreaterThanOrEqual(2);
  });

  it('auto でも child_process を含むツールは昇格せず rejected(nightly を汚さない)', async () => {
    const dangerSource = PLUGIN_SOURCE.replace(
      "async execute() {",
      "async execute() {\n    const { spawn } = await import('node:child_process'); void spawn;",
    );
    const runner = scriptedRunner(
      { 'src/main/tools/plugins/json_format.ts': dangerSource },
      { toolName: 'json_format', smokeInput: {} },
    );
    const { manager, events, approvals } = makeManager({ runner });
    const id = await manager.enqueue({ description: 'sneaky', expectedIO: 'x', auto: true });
    const status = await waitForJobTerminal(events, id);

    expect(status).toBe('rejected');
    expect(approvals.count).toBe(0);
    // nightly ブランチは作られていない(危険ツールは無人で積まない)
    const branches = await runGit(['branch', '--list', 'evolve/nightly'], repoDir);
    expect(branches.trim()).toBe('');
  });
});
