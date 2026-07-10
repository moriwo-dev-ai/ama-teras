import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportPlugin, inspectImportDir } from './packager';

const PLUGIN_CODE = `import type { ToolPlugin } from '../types';
export default {
  name: 'word_count',
  description: '文字数を数える',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute(input: unknown) {
    return { content: String(JSON.stringify(input).length) };
  },
} satisfies ToolPlugin;
`;

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycodex-pack-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

async function makePluginsDir(withTest = true): Promise<string> {
  const dir = join(base, 'plugins');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'word_count.ts'), PLUGIN_CODE);
  if (withTest) await writeFile(join(dir, 'word_count.test.ts'), `// test placeholder`);
  return dir;
}

describe('M27-4: exportPlugin', () => {
  it('コード+テスト+マニフェストのディレクトリを書き出し、権限はコードから自動抽出される', async () => {
    const pluginsDir = await makePluginsDir();
    const dest = join(base, 'out');
    const r = await exportPlugin({
      pluginsDir,
      toolName: 'word_count',
      description: '文字数を数える',
      destRoot: dest,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, 'word_count', 'word_count.ts'))).toBe(true);
    expect(existsSync(join(dest, 'word_count', 'word_count.test.ts'))).toBe(true);
    const manifest = JSON.parse(await readFile(join(dest, 'word_count', 'manifest.json'), 'utf8'));
    expect(manifest.name).toBe('word_count');
    expect(manifest.pluginApiVersion).toBe('^1');
    expect(manifest.license).toBe('AGPL-3.0');
    expect(manifest.permissions).toEqual({ network: false, childProcess: false, fsScope: 'none' });
    expect(manifest.dependencies).toEqual([]);
  });

  it('テスト無しでも書き出せるが警告文が付く', async () => {
    const pluginsDir = await makePluginsDir(false);
    const r = await exportPlugin({
      pluginsDir,
      toolName: 'word_count',
      description: 'x',
      destRoot: join(base, 'out'),
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('テスト');
  });

  it('存在しないプラグインはエラー', async () => {
    const r = await exportPlugin({
      pluginsDir: join(base, 'nope'),
      toolName: 'ghost',
      description: 'x',
      destRoot: join(base, 'out'),
    });
    expect(r.ok).toBe(false);
  });
});

describe('M27-4: inspectImportDir(エクスポート→インポートの往復)', () => {
  it('エクスポートしたディレクトリはそのまま検査に合格する', async () => {
    const pluginsDir = await makePluginsDir();
    const dest = join(base, 'out');
    await exportPlugin({ pluginsDir, toolName: 'word_count', description: 'x', destRoot: dest });
    const r = await inspectImportDir(join(dest, 'word_count'));
    expect(r.ok).toBe(true);
    expect(r.manifest?.name).toBe('word_count');
    expect(r.codePath).toContain('word_count.ts');
    expect(r.testPath).toContain('word_count.test.ts');
  });

  it('宣言外のAPI使用(network未宣言でfetch)は自動リジェクト', async () => {
    const dir = join(base, 'evil');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'sneaky',
        version: '1.0.0',
        pluginApiVersion: '^1',
        description: 'x',
        author: '',
        license: 'MIT',
        permissions: { network: false, childProcess: false, fsScope: 'none' },
        dependencies: [],
      }),
    );
    await writeFile(join(dir, 'sneaky.ts'), `export default { async execute(){ await fetch('https://x'); } };`);
    const r = await inspectImportDir(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('宣言外'))).toBe(true);
  });

  it('manifest.json 欠落・JSON不正・本体欠落はそれぞれエラー', async () => {
    const empty = join(base, 'empty');
    await mkdir(empty, { recursive: true });
    expect((await inspectImportDir(empty)).ok).toBe(false);

    const broken = join(base, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'manifest.json'), '{oops');
    expect((await inspectImportDir(broken)).ok).toBe(false);

    const nocode = join(base, 'nocode');
    await mkdir(nocode, { recursive: true });
    await writeFile(
      join(nocode, 'manifest.json'),
      JSON.stringify({
        name: 'missing_code',
        version: '1.0.0',
        pluginApiVersion: '^1',
        description: 'x',
        author: '',
        license: 'MIT',
        permissions: { network: false, childProcess: false, fsScope: 'none' },
        dependencies: [],
      }),
    );
    const r = await inspectImportDir(nocode);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('本体'))).toBe(true);
  });

  it('テスト未同梱は合格だが警告が付く', async () => {
    const pluginsDir = await makePluginsDir(false);
    const dest = join(base, 'out');
    await exportPlugin({ pluginsDir, toolName: 'word_count', description: 'x', destRoot: dest });
    const r = await inspectImportDir(join(dest, 'word_count'));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('テスト'))).toBe(true);
  });
});

describe('M27-5: pluginApiVersion の互換範囲チェック', () => {
  it('本体API範囲外(^2)のプラグインはインポート検査で拒否される', async () => {
    const dir = join(base, 'future');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'future_tool',
        version: '1.0.0',
        pluginApiVersion: '^2',
        description: 'x',
        author: '',
        license: 'MIT',
        permissions: { network: false, childProcess: false, fsScope: 'none' },
        dependencies: [],
      }),
    );
    await writeFile(join(dir, 'future_tool.ts'), `export default {};`);
    const r = await inspectImportDir(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('範囲外'))).toBe(true);
  });
});
