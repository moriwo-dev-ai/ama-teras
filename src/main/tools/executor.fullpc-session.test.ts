import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequestPayload } from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { executeToolWithApproval, type ExecutorDeps, type ScopeAuditEvent } from './executor';
import type { ToolContext, ToolPlugin } from './types';

/**
 * M14-5: fullPcAllowSession の不変条件を固定する。
 * - 既定OFF: M9どおり systemスコープは毎回承認・allow-sessionを受理しても記憶しない
 * - ON: ツール×ディレクトリ粒度で記憶。別フォルダ・別ツールは再承認。exec系は対象外。
 *   ハード拒否は不変。自動通過も audit に全件記録
 */

const fakeWrite: ToolPlugin = {
  name: 'fake_write',
  description: 'w',
  inputSchema: { type: 'object', properties: {} },
  risk: 'write',
  pathParams: ['path'],
  execute: async () => ({ content: 'written' }),
};
const fakeWrite2: ToolPlugin = { ...fakeWrite, name: 'fake_write2' };
const fakeExec: ToolPlugin = {
  name: 'fake_exec',
  description: 'e',
  inputSchema: { type: 'object', properties: {} },
  risk: 'exec',
  execute: async () => ({ content: 'executed' }),
};

let base: string;
let ws: string;
let outsideA: string;
let outsideB: string;
let userData: string;
let requests: ApprovalRequestPayload[];
let broker: ApprovalBroker;
let audits: ScopeAuditEvent[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'amateras-fullpc-'));
  ws = join(base, 'ws');
  outsideA = join(base, 'outside-a');
  outsideB = join(base, 'outside-b');
  userData = join(base, 'userdata');
  for (const d of [ws, outsideA, outsideB, userData]) await mkdir(d, { recursive: true });
  requests = [];
  audits = [];
  broker = new ApprovalBroker((req) => requests.push(req));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

function deps(allowSession: boolean): ExecutorDeps {
  return {
    registry: {
      get: (n) =>
        n === 'fake_write' ? fakeWrite : n === 'fake_write2' ? fakeWrite2 : n === 'fake_exec' ? fakeExec : undefined,
    },
    broker,
    getAutoApprove: () => ({ safe: true, write: true, exec: true }),
    getScopePolicy: () => ({ mode: 'fullPc', workspaceRoot: ws, deny: { userDataDir: userData } }),
    audit: (e) => audits.push(e),
    getFullPcAllowSession: () => allowSession,
  };
}

function ctx(): ToolContext {
  return { cwd: ws, signal: new AbortController().signal, log: () => {} };
}

async function respondNext(decision: 'allow' | 'allow-session' | 'deny'): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
  const last = requests[requests.length - 1];
  if (last) broker.respond(last.id, decision);
}

describe('fullPcAllowSession(M14-5)', () => {
  it('既定OFF: allow-session を受理しても記憶されず、同一フォルダでも毎回承認(M9回帰)', async () => {
    const d = deps(false);
    const p1 = executeToolWithApproval(d, 'fake_write', { path: join(outsideA, 'a.txt') }, ctx());
    await respondNext('allow-session');
    expect((await p1).isError).not.toBe(true);
    // ボタン表示用ラベルも付かない
    expect(requests[0]!.allowSessionLabel).toBeUndefined();

    const p2 = executeToolWithApproval(d, 'fake_write', { path: join(outsideA, 'b.txt') }, ctx());
    await respondNext('allow');
    await p2;
    expect(requests).toHaveLength(2); // 2回目も承認が要る
  });

  it('ON: ディレクトリ粒度で記憶され、同一フォルダは自動通過+audit全件記録', async () => {
    const d = deps(true);
    const p1 = executeToolWithApproval(d, 'fake_write', { path: join(outsideA, 'a.txt') }, ctx());
    await respondNext('allow-session');
    expect((await p1).isError).not.toBe(true);
    expect(requests[0]!.allowSessionLabel).toContain('このフォルダ');
    expect(requests[0]!.scope).toBe('system');

    // 同一フォルダ2回目: ダイアログなしで通るが、監査には approval(auto)+result が残る
    const before = requests.length;
    const r2 = await executeToolWithApproval(d, 'fake_write', { path: join(outsideA, 'b.txt') }, ctx());
    expect(r2.isError).not.toBe(true);
    expect(requests.length).toBe(before);
    const autoApprovals = audits.filter((a) => a.detail === 'allow(session-auto)');
    expect(autoApprovals).toHaveLength(1);
    expect(audits.filter((a) => a.event === 'result')).toHaveLength(2);

    // 別フォルダ: 再承認
    const p3 = executeToolWithApproval(d, 'fake_write', { path: join(outsideB, 'c.txt') }, ctx());
    await respondNext('deny');
    expect((await p3).isError).toBe(true);
    expect(requests.length).toBe(before + 1);

    // 別ツール×同一フォルダ: 再承認(ツール×ディレクトリ単位)
    const p4 = executeToolWithApproval(d, 'fake_write2', { path: join(outsideA, 'd.txt') }, ctx());
    await respondNext('allow');
    await p4;
    expect(requests.length).toBe(before + 2);
  });

  it('ON でも exec系は対象外(ラベルなし・allow-sessionは記憶されない)', async () => {
    const d = deps(true);
    const p1 = executeToolWithApproval(d, 'fake_exec', { command: 'echo x' }, ctx());
    await respondNext('allow-session');
    await p1;
    expect(requests[0]!.allowSessionLabel).toBeUndefined();

    const p2 = executeToolWithApproval(d, 'fake_exec', { command: 'echo y' }, ctx());
    await respondNext('allow');
    await p2;
    expect(requests).toHaveLength(2); // 毎回承認のまま
  });

  it('ON でもハード拒否(userData)は承認ダイアログなしで即拒否', async () => {
    const d = deps(true);
    const r = await executeToolWithApproval(d, 'fake_write', { path: join(userData, 'secrets.json') }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('保護領域');
    expect(requests).toHaveLength(0);
    expect(audits.some((a) => a.event === 'hard-deny')).toBe(true);
  });
});
