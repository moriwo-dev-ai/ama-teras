import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvolutionJobSummary } from '../../shared/types';
import { evidenceMatchesCode, LocalToolEvolution, type GateEvidence } from './local';
import type { EvolutionJobRunner, JobArtifacts } from './job';

/**
 * M91: 配布版のツール生成(git・worktree・vitest 無し)。
 * 生成器だけを差し替え、**検証ゲートと導入は本物**を走らせる
 * (ここをモックしたら「配布版で本当に作れるのか」を何も確かめていないことになる)
 */

const TYPES_ROOT = join(process.cwd(), 'src');
const TYPE_ROOTS = join(process.cwd(), 'node_modules', '@types');

const okCode = (name: string): string => `import type { ToolPlugin } from '../types';

export function shout(text: string): string {
  return text.toUpperCase();
}

const plugin: ToolPlugin = {
  name: '${name}',
  description: '文字列を大文字にする',
  risk: 'safe',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(input) {
    const text = (input as { text?: string }).text ?? '';
    return { content: shout(text), isError: false };
  },
};
export default plugin;
`;

const okTest = (name: string): string => `import { describe, expect, it } from 'vitest';
import { shout } from './${name}';

describe('${name}', () => {
  it('大文字にする', () => {
    expect(shout('abc')).toBe('ABC');
  });
});
`;

/** 生成器のふり: 指定のコード/テストをサンドボックスに書く */
class FakeRunner implements EvolutionJobRunner {
  calls = 0;
  constructor(private readonly files: (attempt: number) => { name: string; code: string; test?: string }) {}
  async generate(_req: unknown, sandbox: string, log: (l: string) => void): Promise<JobArtifacts> {
    this.calls++;
    const f = this.files(this.calls);
    const dir = join(sandbox, 'src', 'main', 'tools', 'plugins');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${f.name}.ts`), f.code, 'utf8');
    if (f.test !== undefined) await writeFile(join(dir, `${f.name}.test.ts`), f.test, 'utf8');
    log(`生成: ${f.name}`);
    return { toolName: f.name, smokeInput: { text: 'hi' } };
  }
}

let root: string;
let workDir: string;
let userPluginsDir: string;
let events: EvolutionJobSummary[];
let reloads: number;

const make = (
  runner: EvolutionJobRunner,
  approve: (job: EvolutionJobSummary, code: string, warnings: string[]) => Promise<boolean> = async () => true,
): LocalToolEvolution =>
  new LocalToolEvolution({
    workDir,
    userPluginsDir,
    typesRoot: TYPES_ROOT,
    typeRoots: TYPE_ROOTS,
    runner,
    requestPromotionApproval: approve,
    reloadPlugins: async () => {
      reloads++;
    },
    onEvent: (e) => {
      if (e.kind === 'job_update') events.push(e.job);
    },
  });

/** ジョブが終端状態になるまで待つ(enqueue は起票だけして即返る) */
const settle = async (ev: LocalToolEvolution, id: number): Promise<EvolutionJobSummary> => {
  const done = ['done', 'failed', 'rejected', 'cancelled', 'rolled_back'];
  for (let i = 0; i < 600; i++) {
    const job = ev.list().find((j) => j.id === id);
    if (job && done.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('ジョブが終わらない');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amateras-local-'));
  workDir = join(root, 'plugin-gen');
  userPluginsDir = join(root, 'plugins');
  await mkdir(workDir, { recursive: true });
  await mkdir(userPluginsDir, { recursive: true });
  events = [];
  reloads = 0;
});

afterEach(async () => {
  // Windows: 検証子プロセス(esbuild/typecheck)の残ハンドルで EPERM になることがある(全体実行時のフレーク)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('LocalToolEvolution(配布版のツール生成)', () => {
  it('生成 → 検証 → 承認 → 導入まで通り、証跡が残る', async () => {
    const ev = make(new FakeRunner(() => ({ name: 'shout_text', code: okCode('shout_text'), test: okTest('shout_text') })));
    const id = await ev.enqueue({ description: '文字列を大文字にしたい', expectedIO: 'text → 大文字' });
    const job = await settle(ev, id);

    expect(job.status).toBe('done');
    expect(job.gates.map((g) => g.name)).toEqual(['inspect', 'typecheck', 'test', 'smoke']);
    expect(job.gates.every((g) => g.ok)).toBe(true);
    // 実際に userData/plugins へ入っている(コード+テスト+マニフェスト)
    expect(existsSync(join(userPluginsDir, 'shout_text.ts'))).toBe(true);
    expect(existsSync(join(userPluginsDir, 'shout_text.test.ts'))).toBe(true);
    expect(reloads).toBe(1);

    const evidence = JSON.parse(await readFile(join(userPluginsDir, 'shout_text.gate.json'), 'utf8')) as GateEvidence;
    expect(evidence.ok).toBe(true);
    expect(evidence.by).toBe('local');
    const code = await readFile(join(userPluginsDir, 'shout_text.ts'), 'utf8');
    expect(await evidenceMatchesCode(evidence, code)).toBe(true);
    // 導入後にコードを書き換えたら、証跡は無効になる(検証していないものを検証済みと呼ばない)
    expect(await evidenceMatchesCode(evidence, `${code}\n// 手で足した`)).toBe(false);

    // 進捗が UI に流れている
    expect(events.map((e) => e.status)).toContain('verifying');
  }, 90_000);

  it('承認しなければ導入されない(rejected)', async () => {
    const ev = make(
      new FakeRunner(() => ({ name: 'shout_text', code: okCode('shout_text'), test: okTest('shout_text') })),
      async () => false,
    );
    const job = await settle(ev, await ev.enqueue({ description: 'x', expectedIO: 'y' }));
    expect(job.status).toBe('rejected');
    expect(existsSync(join(userPluginsDir, 'shout_text.ts'))).toBe(false);
    expect(reloads).toBe(0);
  }, 90_000);

  it('検証に落ちたら失敗内容を渡して作り直す(2回目で通れば導入される)', async () => {
    const runner = new FakeRunner((attempt) =>
      attempt === 1
        ? { name: 'shout_text', code: okCode('shout_text').replace('text.toUpperCase()', 'text.toUpperCase(1)'), test: okTest('shout_text') }
        : { name: 'shout_text', code: okCode('shout_text'), test: okTest('shout_text') },
    );
    const ev = make(runner);
    const job = await settle(ev, await ev.enqueue({ description: '大文字にしたい', expectedIO: 'text → 大文字' }));
    expect(runner.calls).toBe(2);
    expect(job.status).toBe('done');
  }, 120_000);

  it('テストが無い生成物は導入されない(検証を通れない)', async () => {
    const ev = make(new FakeRunner(() => ({ name: 'shout_text', code: okCode('shout_text') })));
    const job = await settle(ev, await ev.enqueue({ description: 'x', expectedIO: 'y' }));
    expect(job.status).toBe('failed');
    expect(job.gates.at(-1)?.name).toBe('test');
    expect(existsSync(join(userPluginsDir, 'shout_text.ts'))).toBe(false);
  }, 120_000);

  it('本体(core/renderer)の書き換えは断る — 理由と代替(要望)を示す', async () => {
    const ev = make(new FakeRunner(() => ({ name: 'x', code: '', test: '' })));
    await expect(ev.enqueue({ description: 'UIを変えたい', expectedIO: 'x', scope: 'renderer' })).rejects.toThrow(
      /要望/,
    );
  });
});
