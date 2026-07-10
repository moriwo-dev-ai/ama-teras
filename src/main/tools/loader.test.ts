import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPlugins } from './loader';
import { ToolRegistry } from './registry';

const VALID_PLUGIN = (name: string, reply: string): string => `
import type { ToolPlugin } from '../types';
export default {
  name: '${name}',
  description: 'テスト用ツール',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() {
    return { content: '${reply}' };
  },
} satisfies ToolPlugin;
`;

let dir: string;
let cacheDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-plugins-'));
  cacheDir = join(dir, '.cache');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadPlugins', () => {
  it('有効なプラグインをロードする', async () => {
    await writeFile(join(dir, 'hello.ts'), VALID_PLUGIN('hello', 'hi'));
    const { plugins, errors } = await loadPlugins(dir, cacheDir);
    expect(errors).toEqual([]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.plugin.name).toBe('hello');
    const result = await plugins[0]!.plugin.execute({}, dummyCtx());
    expect(result.content).toBe('hi');
  });

  it('name とファイル名の不一致はエラーに積み、他はロード継続', async () => {
    await writeFile(join(dir, 'good.ts'), VALID_PLUGIN('good', 'ok'));
    await writeFile(join(dir, 'bad.ts'), VALID_PLUGIN('mismatch', 'x'));
    const { plugins, errors } = await loadPlugins(dir, cacheDir);
    expect(plugins.map((p) => p.plugin.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.filePath).toContain('bad.ts');
  });

  it('execute の無いモジュールはエラー', async () => {
    await writeFile(join(dir, 'noexec.ts'), `export default { name: 'noexec', description: 'x', inputSchema: { type: 'object', properties: {} }, risk: 'safe' };`);
    const { plugins, errors } = await loadPlugins(dir, cacheDir);
    expect(plugins).toEqual([]);
    expect(errors[0]!.message).toContain('execute');
  });

  it('.test.ts はロード対象外', async () => {
    await writeFile(join(dir, 'hello.ts'), VALID_PLUGIN('hello', 'hi'));
    await writeFile(join(dir, 'hello.test.ts'), 'throw new Error("should not load")');
    const { plugins, errors } = await loadPlugins(dir, cacheDir);
    expect(errors).toEqual([]);
    expect(plugins).toHaveLength(1);
  });
});

describe('ToolRegistry.reload(動的ロード)', () => {
  it('実行中にファイル追加 → reload で新ツールが載る', async () => {
    await writeFile(join(dir, 'first.ts'), VALID_PLUGIN('first', '1'));
    const registry = new ToolRegistry(dir, cacheDir);
    await registry.reload();
    expect(registry.list().map((t) => t.name)).toEqual(['first']);

    await writeFile(join(dir, 'second.ts'), VALID_PLUGIN('second', '2'));
    await registry.reload();
    expect(registry.list().map((t) => t.name).sort()).toEqual(['first', 'second']);
  });

  it('ファイル変更 → reload で新実装に差し替わる(importキャッシュを迂回)', async () => {
    await writeFile(join(dir, 'tool.ts'), VALID_PLUGIN('tool', 'v1'));
    const registry = new ToolRegistry(dir, cacheDir);
    await registry.reload();
    expect((await registry.get('tool')!.execute({}, dummyCtx())).content).toBe('v1');

    await writeFile(join(dir, 'tool.ts'), VALID_PLUGIN('tool', 'v2'));
    await registry.reload();
    expect((await registry.get('tool')!.execute({}, dummyCtx())).content).toBe('v2');
  });

  // 効率: 内容変更で古い .mjs が溜まらない(孤児プルーニング)
  it('reload を重ねても cacheDir に古い .mjs が蓄積しない', async () => {
    await writeFile(join(dir, 'tool.ts'), VALID_PLUGIN('tool', 'v1'));
    const registry = new ToolRegistry(dir, cacheDir);
    await registry.reload();
    for (const v of ['v2', 'v3', 'v4']) {
      await writeFile(join(dir, 'tool.ts'), VALID_PLUGIN('tool', v));
      await registry.reload();
    }
    const mjs = (await readdir(cacheDir)).filter((f) => f.endsWith('.mjs'));
    expect(mjs).toHaveLength(1); // 現行版のみ残る
  });
});

function dummyCtx(): { cwd: string; signal: AbortSignal; log: () => void } {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} };
}

describe('M27-5: pluginApiVersion によるロード時の無効化', () => {
  const PLUGIN = `export default {
  name: 'versioned_tool',
  description: 'x',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() { return { content: 'ok' }; },
};
`;
  const manifest = (range: string): string =>
    JSON.stringify({ name: 'versioned_tool', pluginApiVersion: range });

  it('範囲内(^1)のマニフェスト付きプラグインは普通にロードされる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amateras-apiver-'));
    try {
      await writeFile(join(dir, 'versioned_tool.ts'), PLUGIN);
      await writeFile(join(dir, 'versioned_tool.manifest.json'), manifest('^1'));
      const r = await loadPlugins(dir, join(dir, 'cache'));
      expect(r.plugins.some((p) => p.plugin.name === 'versioned_tool')).toBe(true);
      expect(r.errors).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('範囲外(^2)はクラッシュではなく無効化+理由が errors に載る', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amateras-apiver-'));
    try {
      await writeFile(join(dir, 'versioned_tool.ts'), PLUGIN);
      await writeFile(join(dir, 'versioned_tool.manifest.json'), manifest('^2'));
      const r = await loadPlugins(dir, join(dir, 'cache'));
      expect(r.plugins.some((p) => p.plugin.name === 'versioned_tool')).toBe(false);
      expect(r.errors.some((e) => e.message.includes('範囲外'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('マニフェスト無し・破損マニフェストは従来どおりロードされる(後方互換)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'amateras-apiver-'));
    try {
      await writeFile(join(dir, 'versioned_tool.ts'), PLUGIN);
      await writeFile(join(dir, 'versioned_tool.manifest.json'), '{broken');
      const r = await loadPlugins(dir, join(dir, 'cache'));
      expect(r.plugins.some((p) => p.plugin.name === 'versioned_tool')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
