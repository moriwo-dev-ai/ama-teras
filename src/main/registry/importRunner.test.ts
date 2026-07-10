import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvolutionJobRunner, EvolutionRequest } from '../evolution/job';
import { composeRunners, ImportJobRunner } from './importRunner';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycodex-imprun-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

async function makeImportDir(): Promise<string> {
  const dir = join(base, 'pkg');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'hello_tool',
      version: '1.0.0',
      pluginApiVersion: '^1',
      description: '挨拶する',
      author: 'someone',
      license: 'MIT',
      permissions: { network: false, childProcess: false, fsScope: 'none' },
      dependencies: [],
      smoke: { input: { name: 'world' } },
    }),
  );
  await writeFile(join(dir, 'hello_tool.ts'), `export default { name: 'hello_tool' };`);
  await writeFile(join(dir, 'hello_tool.test.ts'), `// test`);
  return dir;
}

async function makeWorktree(): Promise<string> {
  const wt = join(base, 'worktree');
  await mkdir(join(wt, 'src', 'main', 'tools', 'plugins'), { recursive: true });
  return wt;
}

const req = (importFrom?: string): EvolutionRequest => ({
  description: 'インポート',
  expectedIO: 'x',
  scope: 'tool',
  ...(importFrom !== undefined ? { importFrom } : {}),
});

describe('M27-4: ImportJobRunner', () => {
  it('コード+テストを worktree のプラグインディレクトリへコピーし、manifest の smoke 入力を返す', async () => {
    const dir = await makeImportDir();
    const wt = await makeWorktree();
    const logs: string[] = [];
    const artifacts = await new ImportJobRunner().generate(
      req(dir),
      wt,
      (l) => logs.push(l),
      new AbortController().signal,
    );
    expect(artifacts).toEqual({ toolName: 'hello_tool', smokeInput: { name: 'world' } });
    expect(existsSync(join(wt, 'src/main/tools/plugins/hello_tool.ts'))).toBe(true);
    expect(existsSync(join(wt, 'src/main/tools/plugins/hello_tool.test.ts'))).toBe(true);
    // M27-5: マニフェストも同梱される(将来のAPIメジャーアップ時の無効化判定に使う)
    expect(existsSync(join(wt, 'src/main/tools/plugins/hello_tool.manifest.json'))).toBe(true);
    // 権限宣言がログ(承認時の判断材料)に出る
    expect(logs.some((l) => l.includes('network=false'))).toBe(true);
  });

  it('feedback付き(=ゲート不合格後の2回目)は再コピーせず即座に失敗させる', async () => {
    const dir = await makeImportDir();
    const wt = await makeWorktree();
    await expect(
      new ImportJobRunner().generate(req(dir), wt, () => {}, new AbortController().signal, 'typecheck: NG'),
    ).rejects.toThrow('検証ゲート不合格');
  });

  it('インポート元が検査不合格ならコピーせずエラー', async () => {
    const wt = await makeWorktree();
    await expect(
      new ImportJobRunner().generate(req(join(base, 'nothing')), wt, () => {}, new AbortController().signal),
    ).rejects.toThrow('検査に失敗');
  });
});

describe('M27-4: composeRunners(振り分け)', () => {
  it('importFrom ありは importer、なしは generator に振り分ける', async () => {
    const generator: EvolutionJobRunner = { generate: vi.fn(async () => ({ toolName: 'gen' })) };
    const importer: EvolutionJobRunner = { generate: vi.fn(async () => ({ toolName: 'imp' })) };
    const composed = composeRunners(generator, importer);
    const signal = new AbortController().signal;

    const a = await composed.generate(req(), '/wt', () => {}, signal);
    expect(a.toolName).toBe('gen');
    const b = await composed.generate(req('/pkg'), '/wt', () => {}, signal);
    expect(b.toolName).toBe('imp');
    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(importer.generate).toHaveBeenCalledTimes(1);
  });
});
