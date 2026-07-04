import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from './config';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-config-'));
  file = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('ConfigStore', () => {
  it('ファイルが無ければ既定を返す', () => {
    const store = new ConfigStore(file);
    const c = store.get();
    expect(c.provider).toBe('anthropic');
    expect(c.model).toBe('');
    expect(c.workspace).toBeUndefined();
    expect(c.scopeMode).toBe('project');
  });

  it('set した内容が永続化され再読込で復元される(workspace含む)', () => {
    const store = new ConfigStore(file);
    store.set({
      autoApprove: { safe: true, write: true, exec: false },
      provider: 'openai',
      model: 'gpt-5.1',
      workspace: 'C:/work/proj',
      scopeMode: 'fullPc',
    });
    const reloaded = new ConfigStore(file);
    const c = reloaded.get();
    expect(c.provider).toBe('openai');
    expect(c.workspace).toBe('C:/work/proj');
    expect(c.autoApprove.write).toBe(true);
    expect(c.scopeMode).toBe('fullPc');
  });

  it('scopeMode が無い既存設定ファイルは project にフォールバック(後方互換)', async () => {
    await writeFile(file, JSON.stringify({ provider: 'openai', model: '' }));
    expect(new ConfigStore(file).get().scopeMode).toBe('project');
  });

  it('不正な scopeMode は project にフォールバック', async () => {
    await writeFile(file, JSON.stringify({ scopeMode: 'yolo' }));
    expect(new ConfigStore(file).get().scopeMode).toBe('project');
  });

  it('空文字の workspace は未設定として扱う', async () => {
    await writeFile(file, JSON.stringify({ provider: 'anthropic', model: '', workspace: '' }));
    const c = new ConfigStore(file).get();
    expect(c.workspace).toBeUndefined();
  });

  it('壊れたJSONは既定にフォールバック', async () => {
    await writeFile(file, '{ broken');
    const c = new ConfigStore(file).get();
    expect(c.provider).toBe('anthropic');
  });
});
