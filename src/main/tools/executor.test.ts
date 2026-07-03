import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequestPayload, AutoApproveSettings } from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { executeToolWithApproval, type ExecutorDeps } from './executor';
import { ToolRegistry } from './registry';

const WRITE_PLUGIN = `
import type { ToolPlugin } from '../types';
export default {
  name: 'fake_write',
  description: 'テスト用書き込みツール',
  inputSchema: { type: 'object', properties: {} },
  risk: 'write',
  async execute() {
    return { content: 'written' };
  },
} satisfies ToolPlugin;
`;

let dir: string;
let registry: ToolRegistry;
let requests: ApprovalRequestPayload[];
let broker: ApprovalBroker;

function deps(auto: Partial<AutoApproveSettings> = {}): ExecutorDeps {
  return {
    registry,
    broker,
    getAutoApprove: () => ({ safe: true, write: false, exec: false, ...auto }),
  };
}

function ctx(): { cwd: string; signal: AbortSignal; log: () => void } {
  return { cwd: dir, signal: new AbortController().signal, log: () => {} };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-exec-'));
  await writeFile(join(dir, 'fake_write.ts'), WRITE_PLUGIN);
  registry = new ToolRegistry(dir, join(dir, '.cache'));
  await registry.reload();
  requests = [];
  broker = new ApprovalBroker((req) => requests.push(req));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('executeToolWithApproval', () => {
  it('未知ツールはエラー', async () => {
    const r = await executeToolWithApproval(deps(), 'nope', {}, ctx());
    expect(r.isError).toBe(true);
  });

  it('承認が必要な場合はリクエストを push し、allow で実行される', async () => {
    const promise = executeToolWithApproval(deps(), 'fake_write', { a: 1 }, ctx());
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolName).toBe('fake_write');
    broker.respond(requests[0]!.id, 'allow');
    expect((await promise).content).toBe('written');
  });

  it('deny で実行されずエラー結果', async () => {
    const promise = executeToolWithApproval(deps(), 'fake_write', {}, ctx());
    await new Promise((r) => setTimeout(r, 10));
    broker.respond(requests[0]!.id, 'deny');
    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.content).toContain('拒否');
  });

  it('allow-session 後は同ツールの再実行で承認を挟まない', async () => {
    const p1 = executeToolWithApproval(deps(), 'fake_write', {}, ctx());
    await new Promise((r) => setTimeout(r, 10));
    broker.respond(requests[0]!.id, 'allow-session');
    await p1;

    const r2 = await executeToolWithApproval(deps(), 'fake_write', {}, ctx());
    expect(requests).toHaveLength(1);
    expect(r2.content).toBe('written');
  });

  it('autoApprove.write が true なら承認なしで実行', async () => {
    const r = await executeToolWithApproval(deps({ write: true }), 'fake_write', {}, ctx());
    expect(requests).toHaveLength(0);
    expect(r.content).toBe('written');
  });

  // 回帰: 承認待ち中にキャンセルすると Promise が永久未解決になりループがハングしていた(指摘#2)
  it('承認待ち中に signal が abort されたらハングせず deny 結果を返す', async () => {
    const ac = new AbortController();
    const abortCtx = { cwd: dir, signal: ac.signal, log: () => {} };
    const promise = executeToolWithApproval(deps(), 'fake_write', {}, abortCtx);
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toHaveLength(1); // ダイアログは出ている
    ac.abort(); // ユーザーがチャットをキャンセル
    const r = await promise; // ハングせず解決すること(タイムアウトしないのが要点)
    expect(r.isError).toBe(true);
    expect(r.content).toContain('拒否');
  });
});
