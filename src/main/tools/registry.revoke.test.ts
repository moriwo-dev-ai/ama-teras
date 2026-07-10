import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry';
import type { ToolPlugin } from './types';

/** M27-4: キルスイッチ(失効リスト)によるプラグイン無効化の registry 側挙動 */

const PLUGIN = `export default {
  name: 'ghost_tool',
  description: 'テスト用',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  async execute() { return { content: 'ok' }; },
};
`;

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycodex-revoke-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

async function makeRegistry(): Promise<ToolRegistry> {
  const pluginsDir = join(base, 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(join(pluginsDir, 'ghost_tool.ts'), PLUGIN);
  const registry = new ToolRegistry(pluginsDir, join(base, 'cache'));
  await registry.reload();
  return registry;
}

describe('M27-4: ToolRegistry.revoke(キルスイッチ)', () => {
  it('ロード済みプラグインを無効化し、理由が errors(ユーザー通知)に載る', async () => {
    const registry = await makeRegistry();
    expect(registry.get('ghost_tool')).toBeDefined();

    const hit = registry.revoke('ghost_tool', '脆弱性が報告された');
    expect(hit).toBe(true);
    expect(registry.get('ghost_tool')).toBeUndefined();
    expect(registry.list().some((t) => t.name === 'ghost_tool')).toBe(false);
    expect(registry.errors.some((e) => e.filePath === 'revoked:ghost_tool' && e.message.includes('脆弱性'))).toBe(true);
  });

  it('reload 後も失効が持続する(復活しない)', async () => {
    const registry = await makeRegistry();
    registry.revoke('ghost_tool', 'x');
    await registry.reload();
    expect(registry.get('ghost_tool')).toBeUndefined();
    expect(registry.errors.some((e) => e.filePath === 'revoked:ghost_tool')).toBe(true);
  });

  it('外部ツール(MCP)にも適用され、未ロード名の revoke は false', async () => {
    const registry = await makeRegistry();
    const ext: ToolPlugin = {
      name: 'mcp_ext',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe',
      execute: async () => ({ content: 'ok' }),
    };
    registry.registerExternal([ext]);
    expect(registry.revoke('mcp_ext', 'y')).toBe(true);
    expect(registry.get('mcp_ext')).toBeUndefined();
    expect(registry.revoke('never_loaded', 'z')).toBe(false);
  });
});
