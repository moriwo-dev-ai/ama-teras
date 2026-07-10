import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpConfig } from '../../shared/types';
import type { ToolPlugin } from '../tools/types';
import {
  isValidServerName,
  McpManager,
  mcpServerOfTool,
  riskForAnnotations,
  type McpRegistryLike,
} from './manager';

/** M13-2: モックMCPサーバー(InMemoryTransport・子プロセスなし)で接続〜実行を検証 */

interface MockTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

function mockMcpServer(tools: MockTool[], callImpl?: (name: string, args: unknown) => { content: unknown[]; isError?: boolean }) {
  const server = new Server({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    if (callImpl) return callImpl(req.params.name, req.params.arguments);
    return { content: [{ type: 'text', text: `echo:${req.params.name}:${JSON.stringify(req.params.arguments ?? {})}` }] };
  });
  return server;
}

function mockRegistry(preexisting: string[] = []): McpRegistryLike & { tools: Map<string, ToolPlugin>; cleared: string[] } {
  const tools = new Map<string, ToolPlugin>();
  const cleared: string[] = [];
  const taken = new Set(preexisting);
  return {
    tools,
    cleared,
    registerExternal: (plugins) => {
      const rejected: string[] = [];
      for (const p of plugins) {
        if (taken.has(p.name) || tools.has(p.name)) rejected.push(p.name);
        else tools.set(p.name, p);
      }
      return { rejected };
    },
    clearExternal: (prefix) => {
      cleared.push(prefix);
      for (const name of [...tools.keys()]) if (name.startsWith(prefix)) tools.delete(name);
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-mcp-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function writeConfig(config: McpConfig): Promise<string> {
  const p = join(dir, 'mcp.json');
  await writeFile(p, JSON.stringify(config), 'utf8');
  return p;
}

describe('riskForAnnotations / 名前規約', () => {
  it('readOnly→safe / destructive→exec / その他→write / annotationsなし→exec(安全側)', () => {
    expect(riskForAnnotations({ readOnlyHint: true })).toBe('safe');
    expect(riskForAnnotations({ destructiveHint: true })).toBe('exec');
    expect(riskForAnnotations({ idempotentHint: true })).toBe('write');
    expect(riskForAnnotations({})).toBe('write');
    expect(riskForAnnotations(undefined)).toBe('exec');
  });

  it('mcpServerOfTool はツール名からサーバー名を取り出す', () => {
    expect(mcpServerOfTool('mcp__fs__read_file')).toBe('fs');
    expect(mcpServerOfTool('mcp__my-srv__do__thing')).toBe('my-srv');
    expect(mcpServerOfTool('write_file')).toBeNull();
  });

  it('サーバー名は英数小文字とハイフンのみ(__ 混入を防ぐ)', () => {
    expect(isValidServerName('fs')).toBe(true);
    expect(isValidServerName('my-server1')).toBe(true);
    expect(isValidServerName('My_Server')).toBe(false);
    expect(isValidServerName('a__b')).toBe(false);
    expect(isValidServerName('')).toBe(false);
  });
});

describe('McpManager(M13-2)', () => {
  it('接続→ツール列挙→mcp__名で登録され、risk写像が効く', async () => {
    const server = mockMcpServer([
      { name: 'read_thing', annotations: { readOnlyHint: true } },
      { name: 'write_thing', annotations: { idempotentHint: false } },
      { name: 'nuke', annotations: { destructiveHint: true } },
      { name: 'mystery' }, // annotationsなし
    ]);
    const registry = mockRegistry();
    const manager = new McpManager({
      registry,
      configPath: await writeConfig({ servers: { srv: { command: 'unused', trusted: true } } }),
      createTransport: () => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        void server.connect(serverT);
        return clientT;
      },
    });
    await manager.syncAll();

    expect(manager.status()).toEqual([
      expect.objectContaining({ name: 'srv', state: 'connected', toolCount: 4 }),
    ]);
    expect(registry.tools.get('mcp__srv__read_thing')?.risk).toBe('safe');
    expect(registry.tools.get('mcp__srv__write_thing')?.risk).toBe('write');
    expect(registry.tools.get('mcp__srv__nuke')?.risk).toBe('exec');
    expect(registry.tools.get('mcp__srv__mystery')?.risk).toBe('exec');
    expect(registry.tools.get('mcp__srv__read_thing')?.warnings?.join()).toContain('MCP');
    await manager.closeAll();
  });

  it('アダプタ経由でツールを実行でき、isError も伝播する', async () => {
    const server = mockMcpServer(
      [{ name: 'echo' }, { name: 'fail' }],
      (name, args) =>
        name === 'fail'
          ? { content: [{ type: 'text', text: '失敗した' }], isError: true }
          : { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] },
    );
    const registry = mockRegistry();
    const manager = new McpManager({
      registry,
      configPath: await writeConfig({ servers: { srv: { command: 'unused', trusted: true } } }),
      createTransport: () => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        void server.connect(serverT);
        return clientT;
      },
    });
    await manager.syncAll();

    const ctx = { cwd: '/x', signal: new AbortController().signal, log: () => {} };
    const ok = await registry.tools.get('mcp__srv__echo')!.execute({ msg: 'hi' }, ctx);
    expect(ok.isError).not.toBe(true);
    expect(ok.content).toBe('echo:{"msg":"hi"}');
    const bad = await registry.tools.get('mcp__srv__fail')!.execute({}, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toBe('失敗した');
    await manager.closeAll();
  });

  it('名前衝突は登録拒否され、状態にエラーとして出る', async () => {
    const server = mockMcpServer([{ name: 'dup', annotations: { readOnlyHint: true } }, { name: 'ok', annotations: { readOnlyHint: true } }]);
    const registry = mockRegistry(['mcp__srv__dup']); // 既に同名が存在
    const manager = new McpManager({
      registry,
      configPath: await writeConfig({ servers: { srv: { command: 'unused', trusted: true } } }),
      createTransport: () => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        void server.connect(serverT);
        return clientT;
      },
    });
    await manager.syncAll();
    const st = manager.status()[0]!;
    expect(st.state).toBe('connected');
    expect(st.toolCount).toBe(1);
    expect(st.error).toContain('mcp__srv__dup');
    await manager.closeAll();
  });

  it('未信頼・無効サーバーには接続しない(transportも作らない)', async () => {
    let created = 0;
    const registry = mockRegistry();
    const manager = new McpManager({
      registry,
      configPath: await writeConfig({
        servers: {
          untrusted: { command: 'unused' }, // trusted 未設定
          off: { command: 'unused', trusted: true, enabled: false },
        },
      }),
      createTransport: () => {
        created++;
        throw new Error('到達しないはず');
      },
    });
    await manager.syncAll();
    expect(created).toBe(0);
    const byName = Object.fromEntries(manager.status().map((s) => [s.name, s.state]));
    expect(byName).toEqual({ untrusted: 'untrusted', off: 'disabled' });
  });

  it('接続失敗は該当サーバーだけ error になり、他サーバーは接続される(起動をブロックしない)', async () => {
    const server = mockMcpServer([{ name: 'ok', annotations: { readOnlyHint: true } }]);
    const registry = mockRegistry();
    const manager = new McpManager({
      registry,
      configPath: await writeConfig({
        servers: {
          broken: { command: 'unused', trusted: true },
          good: { command: 'unused', trusted: true },
        },
      }),
      createTransport: (name) => {
        if (name === 'broken') throw new Error('spawn失敗');
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        void server.connect(serverT);
        return clientT;
      },
    });
    await manager.syncAll(); // 例外を投げない
    const byName = Object.fromEntries(manager.status().map((s) => [s.name, s]));
    expect(byName['broken']!.state).toBe('error');
    expect(byName['broken']!.error).toContain('spawn失敗');
    expect(byName['good']!.state).toBe('connected');
    await manager.closeAll();
  });

  it('closeAll で外部ツールが registry から消える', async () => {
    const server = mockMcpServer([{ name: 't', annotations: { readOnlyHint: true } }]);
    const registry = mockRegistry();
    const manager = new McpManager({
      registry,
      configPath: await writeConfig({ servers: { srv: { command: 'unused', trusted: true } } }),
      createTransport: () => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        void server.connect(serverT);
        return clientT;
      },
    });
    await manager.syncAll();
    expect(registry.tools.size).toBe(1);
    await manager.closeAll();
    expect(registry.tools.size).toBe(0);
  });

  it('setConfig は不正なサーバー名を拒否する', async () => {
    const manager = new McpManager({ registry: mockRegistry(), configPath: join(dir, 'mcp.json') });
    await expect(manager.setConfig({ servers: { 'Bad__Name': { command: 'x' } } })).rejects.toThrow('不正');
  });

  it('mcp.json が無い・壊れている場合は空設定として扱う', async () => {
    const manager = new McpManager({ registry: mockRegistry(), configPath: join(dir, 'none.json') });
    expect(manager.getConfig()).toEqual({ servers: {} });
    await writeFile(join(dir, 'broken.json'), '{oops', 'utf8');
    const manager2 = new McpManager({ registry: mockRegistry(), configPath: join(dir, 'broken.json') });
    expect(manager2.getConfig()).toEqual({ servers: {} });
  });
});
