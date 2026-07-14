import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPlugin, uninstallPlugin } from './install';
import { exportPlugin } from '../registry/packager';

/**
 * M90: 配布版で**導入したツールは、そのままではエクスポートできなかった**。
 * - エクスポートは同梱の置き場(resources/plugins)しか見ておらず、導入したプラグインは
 *   userData/plugins にいる → 「プラグインファイルが見つからない」
 * - 導入時にテストファイルを捨てていた → 出せたとしても**テストの無いパッケージ**になり、
 *   レジストリへ投稿できない(投稿にはテストが要る)
 * 入れたものは、そのまま出せなければならない。
 */

let src: string;
let userPlugins: string;
let dest: string;

const CODE = `import type { ToolPlugin } from '../types';
export default {
  name: 'demo_tool',
  description: 'デモ',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() { return { content: 'ok' }; },
} satisfies ToolPlugin;
`;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'm90-'));
  src = join(root, 'src');
  userPlugins = join(root, 'userData', 'plugins');
  dest = join(root, 'out');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(src, 'demo_tool.ts'), CODE, 'utf8');
  writeFileSync(join(src, 'demo_tool.test.ts'), "import { it } from 'vitest';\nit('x', () => {});\n", 'utf8');
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'demo_tool', version: '1.0.0' }), 'utf8');
});
afterEach(() => rmSync(join(userPlugins, '..', '..'), { recursive: true, force: true }));

describe('M90: 入れたツールを、そのまま出せる', () => {
  it('導入するとテストも一緒に置かれる(エクスポート時に消えない)', async () => {
    await installPlugin(src, userPlugins, 'demo_tool');

    expect(existsSync(join(userPlugins, 'demo_tool.ts'))).toBe(true);
    expect(existsSync(join(userPlugins, 'demo_tool.test.ts'))).toBe(true); // 捨てていたやつ
    expect(existsSync(join(userPlugins, 'demo_tool.manifest.json'))).toBe(true);
  });

  it('導入先(userData/plugins)からエクスポートできる — テストも同梱される', async () => {
    await installPlugin(src, userPlugins, 'demo_tool');

    const r = await exportPlugin({
      pluginsDir: userPlugins, // 実際に置かれている場所(以前は同梱ディレクトリしか見ていなかった)
      toolName: 'demo_tool',
      description: 'デモ',
      destRoot: dest,
    });

    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('テストファイルが無い');
    expect(existsSync(join(dest, 'demo_tool', 'demo_tool.ts'))).toBe(true);
    expect(existsSync(join(dest, 'demo_tool', 'demo_tool.test.ts'))).toBe(true);
    expect(existsSync(join(dest, 'demo_tool', 'manifest.json'))).toBe(true);
  });

  it('撤去するとテストも消える(置きっぱなしにしない)', async () => {
    await installPlugin(src, userPlugins, 'demo_tool');
    await uninstallPlugin(userPlugins, 'demo_tool');

    expect(existsSync(join(userPlugins, 'demo_tool.ts'))).toBe(false);
    expect(existsSync(join(userPlugins, 'demo_tool.test.ts'))).toBe(false);
  });
});
