import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installPlugin,
  installPreview,
  isInstalled,
  listInstalledPlugins,
  pluginDangerWarnings,
  preparePluginInstall,
  uninstallPlugin,
} from './install';
import { loadPlugins } from './loader';

/**
 * M71: 配布版には**書き込めるプラグイン置き場が無く**(同梱先は Program Files 配下)、
 * 導入は必ず進化パイプライン(git worktree → typecheck → vitest)を通す作りだったため、
 * ファイルからもレジストリからもツールを入れられなかった(実機の配布版で確認)。
 * git を使わない導入経路を固定する。
 */

const PLUGIN_CODE = (name: string) => `
import type { ToolPlugin } from '../types';
export default {
  name: '${name}',
  description: '行数を数える',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() {
    return { content: 'ok' };
  },
} satisfies ToolPlugin;
`;

const MANIFEST = (name: string) => ({
  name,
  version: '1.0.0',
  pluginApiVersion: '^1',
  description: '行数を数える',
  author: 'tester',
  license: 'AGPL-3.0-or-later',
  permissions: { network: false, childProcess: false, fsScope: 'none' },
  dependencies: [],
});

let src: string;
let userDir: string;
let builtinDir: string;
let cacheDir: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'm71-'));
  src = join(base, 'src');
  userDir = join(base, 'userPlugins');
  builtinDir = join(base, 'builtin');
  cacheDir = join(base, 'cache');
  await mkdir(src, { recursive: true });
  await mkdir(builtinDir, { recursive: true });
});

afterEach(async () => {
  await rm(join(src, '..'), { recursive: true, force: true });
});

async function writeSource(name: string, code = PLUGIN_CODE(name), manifest: object = MANIFEST(name)): Promise<void> {
  await writeFile(join(src, `${name}.ts`), code, 'utf8');
  await writeFile(join(src, 'manifest.json'), JSON.stringify(manifest), 'utf8');
}

describe('M71: 配布版のプラグイン導入(git非依存)', () => {
  it('検査を通ったものだけを userData/plugins に置き、そこからロードできる', async () => {
    await writeSource('line_count');

    const prepared = await preparePluginInstall(src);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.plugin.name).toBe('line_count');

    await installPlugin(src, userDir, 'line_count');
    expect(isInstalled(userDir, 'line_count')).toBe(true);
    expect(await listInstalledPlugins(userDir)).toEqual(['line_count']);

    // 同梱ディレクトリと導入ディレクトリの両方から読める(配布版の実行時構成)
    const { plugins, errors } = await loadPlugins([builtinDir, userDir], cacheDir);
    expect(errors).toEqual([]);
    expect(plugins.map((p) => p.plugin.name)).toEqual(['line_count']);
  });

  it('manifest が無い/壊れているものは何も置かない', async () => {
    await writeFile(join(src, 'broken.ts'), PLUGIN_CODE('broken'), 'utf8');
    const prepared = await preparePluginInstall(src);
    expect(prepared.ok).toBe(false);
    expect(isInstalled(userDir, 'broken')).toBe(false);
  });

  it('組み込みと同名の導入は無効化される(導入物が組み込みを乗っ取れない)', async () => {
    await writeFile(join(builtinDir, 'read_file.ts'), PLUGIN_CODE('read_file'), 'utf8');
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'read_file.ts'), PLUGIN_CODE('read_file'), 'utf8');

    const { plugins, errors } = await loadPlugins([builtinDir, userDir], cacheDir);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.filePath).toContain('builtin');
    expect(errors[0]!.message).toContain('同名');
  });

  it('撤去できる(読み込めなかったときの巻き戻し)', async () => {
    await writeSource('temp_tool');
    await installPlugin(src, userDir, 'temp_tool');
    await uninstallPlugin(userDir, 'temp_tool');
    expect(existsSync(join(userDir, 'temp_tool.ts'))).toBe(false);
    expect(existsSync(join(userDir, 'temp_tool.manifest.json'))).toBe(false);
  });

  it('危険な操作は承認ダイアログ用の警告として必ず申告される', () => {
    const code = "import { execFile } from 'node:child_process'; await fetch('https://x');";
    const warnings = pluginDangerWarnings(code, {
      ...MANIFEST('danger'),
      permissions: { network: true, childProcess: true, fsScope: 'none' },
    } as never);
    expect(warnings.join('\n')).toContain('コマンド実行');
    expect(warnings.join('\n')).toContain('ネットワーク');
    expect(warnings.join('\n')).toContain('宣言された権限');
  });

  it('承認ダイアログにはコード全文と取得元が出る(人間が読んで判断できる)', () => {
    const preview = installPreview(
      { name: 'x', manifest: MANIFEST('x') as never, code: 'const secret = 1;' },
      'レジストリ',
    );
    expect(preview).toContain('const secret = 1;');
    expect(preview).toContain('レジストリ');
  });
});
