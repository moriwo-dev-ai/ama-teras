import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequestPayload, ScopeMode } from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { executeToolWithApproval, type ExecutorDeps, type ScopeAuditEvent } from './executor';
import { ToolRegistry } from './registry';

/**
 * M17-2: 自律モードの executor テスト。
 * - ON中は safe/write/exec/system スコープすべて承認なしで実行される
 * - ハード拒否(secrets/userData/システム破壊)は自律モードでも不変
 * - Windowsシステム領域は「新規作成のみ許可・既存上書き拒否」
 * - exec 系のカタストロフィックなコマンドは denylist で即拒否
 * - 全操作が autonomous:true で監査に記録される
 */

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
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
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

function deps(mode: ScopeMode = 'fullPc', autonomous = true): ExecutorDeps {
  return {
    registry,
    broker,
    // autoApprove 全OFFでも自律モードなら通ることを確かめるため全て false にする
    getAutoApprove: () => ({ safe: false, write: false, exec: false }),
    getScopePolicy: () => ({ mode, workspaceRoot: ws, deny: { userDataDir: userData } }),
    audit: (e) => auditEvents.push(e),
    getAutonomous: () => autonomous,
  };
}

function ctx(): { cwd: string; signal: AbortSignal; log: () => void } {
  return { cwd: ws, signal: new AbortController().signal, log: () => {} };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'amateras-auto-exec-'));
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

describe('自律モード: 自動承認', () => {
  it('write は autoApprove 全OFFでも承認なしで実行される', async () => {
    const r = await executeToolWithApproval(deps(), 'fake_write', { path: join(ws, 'a.txt') }, ctx());
    expect(requests).toHaveLength(0);
    expect(r.content).toBe('written');
  });

  it('system スコープ(workspace外)の write も承認なしで実行される', async () => {
    const r = await executeToolWithApproval(
      deps(),
      'fake_write',
      { path: join(outside, 'a.txt') },
      ctx(),
    );
    expect(requests).toHaveLength(0);
    expect(r.content).toBe('written');
  });

  it('exec(通常コマンド)も承認なしで実行される', async () => {
    const r = await executeToolWithApproval(deps(), 'fake_exec', { command: 'npm run build' }, ctx());
    expect(requests).toHaveLength(0);
    expect(r.content).toBe('executed');
  });

  it('OFF(通常モード)では従来どおり承認要求が出る', async () => {
    const promise = executeToolWithApproval(
      deps('fullPc', false),
      'fake_write',
      { path: join(ws, 'a.txt') },
      ctx(),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toHaveLength(1);
    broker.respond(requests[0]!.id, 'deny');
    expect((await promise).isError).toBe(true);
  });
});

describe('自律モード: ハード拒否は不変', () => {
  it('secrets.json の読み取りは拒否', async () => {
    const r = await executeToolWithApproval(
      deps(),
      'fake_read',
      { path: join(userData, 'secrets.json') },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('secrets.json');
  });

  it('userData への書き込みは新規ファイルでも拒否(plugin-cache注入防止)', async () => {
    const r = await executeToolWithApproval(
      deps(),
      'fake_write',
      { path: join(userData, 'plugin-cache', 'evil.mjs') },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('userData');
    const denies = auditEvents.filter((e) => e.event === 'hard-deny');
    expect(denies).toHaveLength(1);
    expect(denies[0]!.autonomous).toBe(true);
  });

  it('Windowsシステム領域: 既存ファイルの上書きは拒否・新規作成は許可', async () => {
    // 既存(C:\Windows\explorer.exe は必ず存在する)
    const denied = await executeToolWithApproval(
      deps(),
      'fake_write',
      { path: 'C:\\Windows\\explorer.exe' },
      ctx(),
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('Windowsシステム領域');

    // 新規(存在しないパス)→ 自律モードでは許可される
    const created = await executeToolWithApproval(
      deps(),
      'fake_write',
      { path: 'C:\\Windows\\Temp\\amateras-test-does-not-exist-9f2k.txt' },
      ctx(),
    );
    expect(created.isError).not.toBe(true);
    expect(created.content).toBe('written');
  });

  it('通常モードではシステム領域への新規作成も従来どおり拒否', async () => {
    const r = await executeToolWithApproval(
      deps('fullPc', false),
      'fake_write',
      { path: 'C:\\Windows\\Temp\\amateras-test-does-not-exist-9f2k.txt' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Windowsシステム領域');
  });

  it('project モードの workspace 外拒否も不変', async () => {
    const r = await executeToolWithApproval(
      deps('project'),
      'fake_write',
      { path: join(outside, 'a.txt') },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('project');
  });
});

describe('自律モード: exec denylist', () => {
  it('カタストロフィックなコマンドは承認なしでも拒否され、監査に残る', async () => {
    const r = await executeToolWithApproval(deps(), 'fake_exec', { command: 'format c:' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('破壊的コマンド');
    const denies = auditEvents.filter((e) => e.event === 'hard-deny');
    expect(denies).toHaveLength(1);
    expect(denies[0]!.autonomous).toBe(true);
    expect(denies[0]!.detail).toContain('フォーマット');
  });

  it('通常モードでは denylist は作動しない(人間の承認が防波堤)', async () => {
    const promise = executeToolWithApproval(
      deps('fullPc', false),
      'fake_exec',
      { command: 'format c:' },
      ctx(),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toHaveLength(1); // 承認ダイアログに委ねられる
    broker.respond(requests[0]!.id, 'deny');
    await promise;
  });
});

describe('自律モード: 監査', () => {
  it('workspace 内の操作も含め全操作が autonomous:true で記録される', async () => {
    await executeToolWithApproval(deps(), 'fake_write', { path: join(ws, 'a.txt') }, ctx());
    await executeToolWithApproval(deps(), 'fake_read', { path: join(ws, 'a.txt') }, ctx());
    await executeToolWithApproval(deps(), 'fake_exec', { command: 'echo hi' }, ctx());
    const results = auditEvents.filter((e) => e.event === 'result');
    expect(results).toHaveLength(3);
    for (const e of results) expect(e.autonomous).toBe(true);
    expect(results.map((e) => e.tool).sort()).toEqual(['fake_exec', 'fake_read', 'fake_write']);
  });
});
