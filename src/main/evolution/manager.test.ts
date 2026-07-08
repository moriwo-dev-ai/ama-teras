import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvolutionEvent } from '../../shared/types';
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
  base = await mkdtemp(join(tmpdir(), 'mycodex-evo-'));
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
  await rm(base, { recursive: true, force: true }).catch(() => {});
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
}

function makeManager(o: Overrides = {}): {
  manager: EvolutionManager;
  events: EvolutionEvent[];
  reloads: { count: number };
} {
  const events: EvolutionEvent[] = [];
  const reloads = { count: 0 };
  const deps: EvolutionManagerDeps = {
    repoDir,
    worktreeBase: join(base, 'evolve'),
    runner:
      o.runner ??
      scriptedRunner(
        { 'src/main/tools/plugins/json_format.ts': PLUGIN_SOURCE },
        { toolName: 'json_format', smokeInput: {} },
      ),
    requestPromotionApproval: async () => o.approve ?? true,
    reloadPlugins: async () => {
      reloads.count += 1;
    },
    healthCheck: async () => o.healthy ?? true,
    onEvent: (e) => events.push(e),
    // typecheck/vitest/smoke は既定で全成功扱い(差分検査だけ実gitで検証する)
    runCommand: o.runCommand ?? (async () => ({ code: 0, output: 'ok' })),
    ...(o.existingToolNames !== undefined ? { existingToolNames: o.existingToolNames } : {}),
  };
  return { manager: new EvolutionManager(deps), events, reloads };
}

function lastStatus(events: EvolutionEvent[]): string | undefined {
  const updates = events.filter((e) => e.kind === 'job_update');
  return updates.at(-1)?.kind === 'job_update' ? (updates.at(-1) as { job: { status: string } }).job.status : undefined;
}

async function waitForTerminal(events: EvolutionEvent[], timeoutMs = 30_000): Promise<string> {
  const terminal = ['done', 'failed', 'rejected', 'rolled_back'];
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

describe('detectDangerWarnings', () => {
  it('child_processとネットワークを検出する', () => {
    expect(detectDangerWarnings(`+import { spawn } from 'node:child_process';`)).toHaveLength(1);
    expect(detectDangerWarnings(`+const r = await fetch('https://x');`)).toHaveLength(1);
    expect(detectDangerWarnings(`+const a = 1;`)).toHaveLength(0);
  });
});
