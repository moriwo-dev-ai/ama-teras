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
    // typecheck/vitest/smoke は全成功扱い(差分検査だけ実gitで検証する)
    runCommand: async () => ({ code: 0, output: 'ok' }),
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

describe('EvolutionManager(実git統合)', () => {
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

  it('保護領域への変更は差分検査ゲートで無条件fail', async () => {
    const { manager, events } = makeManager({
      runner: scriptedRunner(
        {
          'src/main/tools/plugins/json_format.ts': PLUGIN_SOURCE,
          'src/main/evolution/core.ts': '// 改ざん!',
        },
        { toolName: 'json_format', smokeInput: {} },
      ),
    });
    await manager.enqueue({ description: 'x', expectedIO: 'x' });
    const status = await waitForTerminal(events);
    expect(status).toBe('failed');

    const updates = events.filter((e) => e.kind === 'job_update');
    const gates = (updates.at(-1) as { job: { gates: { name: string; ok: boolean; detail: string }[] } }).job.gates;
    expect(gates[0]).toMatchObject({ name: 'diff_allowlist', ok: false });
    expect(gates[0]!.detail).toContain('src/main/evolution/core.ts');
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

describe('detectDangerWarnings', () => {
  it('child_processとネットワークを検出する', () => {
    expect(detectDangerWarnings(`+import { spawn } from 'node:child_process';`)).toHaveLength(1);
    expect(detectDangerWarnings(`+const r = await fetch('https://x');`)).toHaveLength(1);
    expect(detectDangerWarnings(`+const a = 1;`)).toHaveLength(0);
  });
});
