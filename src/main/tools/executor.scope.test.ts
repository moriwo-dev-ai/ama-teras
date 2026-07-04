import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequestPayload, AutoApproveSettings, ScopeMode } from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { executeToolWithApproval, type ExecutorDeps, type ScopeAuditEvent } from './executor';
import writeFilePlugin from './plugins/write_file';
import { ToolRegistry } from './registry';

// M9: スコープ強制承認のテスト。
// 中核不変条件: system スコープでは autoApprove / allow-session を必ず無視する。

const FAKE_WRITE = `
import type { ToolPlugin } from '../types';
export default {
  name: 'fake_write',
  description: 'テスト用書き込みツール',
  inputSchema: { type: 'object', properties: {} },
  risk: 'write',
  pathParams: ['path'],
  async execute() {
    return { content: 'written' };
  },
} satisfies ToolPlugin;
`;

const FAKE_READ = `
import type { ToolPlugin } from '../types';
export default {
  name: 'fake_read',
  description: 'テスト用読み取りツール',
  inputSchema: { type: 'object', properties: {} },
  risk: 'safe',
  pathParams: ['path'],
  async execute() {
    return { content: 'read' };
  },
} satisfies ToolPlugin;
`;

const FAKE_EXEC = `
import type { ToolPlugin } from '../types';
export default {
  name: 'fake_exec',
  description: 'テスト用実行ツール',
  inputSchema: { type: 'object', properties: {} },
  risk: 'exec',
  async execute() {
    return { content: 'executed' };
  },
} satisfies ToolPlugin;
`;

let base: string;
let ws: string;
let outside: string;
let userData: string;
let registry: ToolRegistry;
let requests: ApprovalRequestPayload[];
let broker: ApprovalBroker;
let auditEvents: ScopeAuditEvent[];

function deps(mode: ScopeMode, auto: Partial<AutoApproveSettings> = {}): ExecutorDeps {
  return {
    registry,
    broker,
    getAutoApprove: () => ({ safe: true, write: true, exec: true, ...auto }),
    getScopePolicy: () => ({ mode, workspaceRoot: ws, deny: { userDataDir: userData } }),
    audit: (e) => auditEvents.push(e),
  };
}

function ctx(): { cwd: string; signal: AbortSignal; log: () => void } {
  return { cwd: ws, signal: new AbortController().signal, log: () => {} };
}

/** 承認ダイアログが出たら decision で応答するヘルパ */
async function respondNext(decision: 'allow' | 'allow-session' | 'deny'): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
  const last = requests[requests.length - 1];
  if (last) broker.respond(last.id, decision);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'mycodex-scope-exec-'));
  ws = join(base, 'ws');
  outside = join(base, 'outside');
  userData = join(base, 'userdata');
  await mkdir(ws, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(userData, { recursive: true });

  const pluginsDir = join(base, 'plugins');
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(join(pluginsDir, 'fake_write.ts'), FAKE_WRITE);
  await writeFile(join(pluginsDir, 'fake_read.ts'), FAKE_READ);
  await writeFile(join(pluginsDir, 'fake_exec.ts'), FAKE_EXEC);
  registry = new ToolRegistry(pluginsDir, join(base, '.cache'));
  await registry.reload();

  requests = [];
  auditEvents = [];
  broker = new ApprovalBroker((req) => requests.push(req));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

describe('systemスコープの強制承認(fullPc)', () => {
  it('autoApprove が全て true でも system スコープは承認要求が出る', async () => {
    const promise = executeToolWithApproval(
      deps('fullPc'),
      'fake_write',
      { path: join(outside, 'a.txt') },
      ctx(),
    );
    await respondNext('allow');
    const r = await promise;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.scope).toBe('system');
    expect(requests[0]!.resolvedPaths).toEqual([join(outside, 'a.txt')]);
    expect(r.content).toBe('written');
  });

  it('allow-session を返しても記憶されず、次回も承認要求が出る', async () => {
    const p1 = executeToolWithApproval(deps('fullPc'), 'fake_write', { path: join(outside, 'a.txt') }, ctx());
    await respondNext('allow-session');
    expect((await p1).content).toBe('written');
    expect(broker.isSessionAllowed('fake_write')).toBe(false);

    const p2 = executeToolWithApproval(deps('fullPc'), 'fake_write', { path: join(outside, 'b.txt') }, ctx());
    await respondNext('allow');
    expect((await p2).content).toBe('written');
    expect(requests).toHaveLength(2);
  });

  it('workspaceスコープで allow-session 済みでも system スコープでは承認要求が出る', async () => {
    broker.allowForSession('fake_write');
    const promise = executeToolWithApproval(
      deps('fullPc', { write: false }),
      'fake_write',
      { path: join(outside, 'a.txt') },
      ctx(),
    );
    await respondNext('deny');
    const r = await promise;
    expect(requests).toHaveLength(1);
    expect(r.isError).toBe(true);
  });

  it('workspace 内のパスは従来どおり autoApprove が効く', async () => {
    const r = await executeToolWithApproval(deps('fullPc'), 'fake_write', { path: join(ws, 'a.txt') }, ctx());
    expect(requests).toHaveLength(0);
    expect(r.content).toBe('written');
  });

  it('拒否したら実行されない', async () => {
    const promise = executeToolWithApproval(deps('fullPc'), 'fake_write', { path: join(outside, 'a.txt') }, ctx());
    await respondNext('deny');
    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.content).toContain('拒否');
  });
});

describe('projectモード(後方互換)', () => {
  it('system スコープは承認ダイアログなしで拒否される', async () => {
    const r = await executeToolWithApproval(deps('project'), 'fake_write', { path: join(outside, 'a.txt') }, ctx());
    expect(requests).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('project');
  });

  it('workspace 内は従来どおり動く(読み取り・書き込み)', async () => {
    const r1 = await executeToolWithApproval(deps('project'), 'fake_read', { path: join(ws, 'a.txt') }, ctx());
    expect(r1.content).toBe('read');
    const r2 = await executeToolWithApproval(deps('project'), 'fake_write', { path: 'rel/a.txt' }, ctx());
    expect(r2.content).toBe('written');
    expect(requests).toHaveLength(0);
  });

  it('path 省略時は cwd(workspace)として扱われ拒否されない', async () => {
    const r = await executeToolWithApproval(deps('project'), 'fake_read', {}, ctx());
    expect(r.content).toBe('read');
  });

  it('getScopePolicy 未指定なら従来挙動(スコープ制御なし)', async () => {
    const d: ExecutorDeps = {
      registry,
      broker,
      getAutoApprove: () => ({ safe: true, write: true, exec: true }),
    };
    const r = await executeToolWithApproval(d, 'fake_write', { path: join(outside, 'a.txt') }, ctx());
    expect(requests).toHaveLength(0);
    expect(r.content).toBe('written');
  });
});

describe('ハード拒否(userData)', () => {
  it('userData への書き込みは承認ダイアログすら出さずエラー(fullPcでも)', async () => {
    const target = join(userData, 'config.json');
    const r = await executeToolWithApproval(deps('fullPc'), 'fake_write', { path: target }, ctx());
    expect(requests).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('保護領域');
    expect(auditEvents.some((e) => e.event === 'hard-deny')).toBe(true);
  });

  it('secrets.json は読み取りもハード拒否', async () => {
    const r = await executeToolWithApproval(
      deps('fullPc'),
      'fake_read',
      { path: join(userData, 'secrets.json') },
      ctx(),
    );
    expect(requests).toHaveLength(0);
    expect(r.isError).toBe(true);
  });
});

describe('audit log', () => {
  it('system スコープの承認と実行結果が記録される', async () => {
    const promise = executeToolWithApproval(deps('fullPc'), 'fake_write', { path: join(outside, 'a.txt') }, ctx());
    await respondNext('allow');
    await promise;
    expect(auditEvents.map((e) => e.event)).toEqual(['approval', 'result']);
    expect(auditEvents[0]!.detail).toBe('allow');
    expect(auditEvents[1]!.detail).toBe('ok');
    expect(auditEvents[0]!.paths).toEqual([join(outside, 'a.txt')]);
  });

  it('拒否も記録される', async () => {
    const promise = executeToolWithApproval(deps('fullPc'), 'fake_write', { path: join(outside, 'a.txt') }, ctx());
    await respondNext('deny');
    await promise;
    expect(auditEvents.map((e) => e.event)).toEqual(['approval']);
    expect(auditEvents[0]!.detail).toBe('deny');
  });

  it('workspace スコープの操作は記録されない', async () => {
    await executeToolWithApproval(deps('fullPc'), 'fake_write', { path: join(ws, 'a.txt') }, ctx());
    expect(auditEvents).toHaveLength(0);
  });
});

describe('進化パイプラインの回帰(writeAllowlist はスコープ制御と独立に維持)', () => {
  it('fullPc で承認しても writeAllowlist 外への write_file は拒否される', async () => {
    const lookup = { get: (n: string) => (n === 'write_file' ? writeFilePlugin : undefined) };
    const d: ExecutorDeps = {
      registry: lookup,
      broker,
      getAutoApprove: () => ({ safe: true, write: true, exec: true }),
      getScopePolicy: () => ({ mode: 'fullPc', workspaceRoot: ws, deny: {} }),
    };
    const evoCtx = {
      cwd: ws,
      writeAllowlist: ['src/main/tools/plugins'],
      restrictExec: true,
      signal: new AbortController().signal,
      log: () => {},
    };
    // workspace 内だが allowlist 外 → プラグイン側の writeAllowlist が拒否する
    const r = await executeToolWithApproval(d, 'write_file', { path: join(ws, 'evil.txt'), content: 'x' }, evoCtx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('書き込み許可外');

    // allowlist 内は書ける
    const ok = await executeToolWithApproval(
      d,
      'write_file',
      { path: join(ws, 'src/main/tools/plugins/new_tool.ts'), content: 'x' },
      evoCtx,
    );
    expect(ok.isError).not.toBe(true);
  });
});
