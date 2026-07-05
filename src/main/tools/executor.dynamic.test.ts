import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestPayload } from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { executeToolWithApproval, type ExecutorDeps, type ScopeAuditEvent } from './executor';
import screenshot from './plugins/screenshot';
import type { ToolContext } from './types';

/**
 * M14-2: 動的承認(screenshot の外部URL)の中核不変条件を固定する。
 * - 外部URLは autoApprove.safe でも毎回承認
 * - 「セッション中許可」はドメイン単位(別ドメインは再承認)
 * - 自動許可された実行も含め、外部URLは全件 audit に記録
 * - 非httpスキームは承認ダイアログも出さず拒否
 */

function setup(): {
  deps: ExecutorDeps;
  requests: ApprovalRequestPayload[];
  audits: ScopeAuditEvent[];
  broker: ApprovalBroker;
  capture: ReturnType<typeof vi.fn>;
  ctx: ToolContext;
} {
  const requests: ApprovalRequestPayload[] = [];
  const audits: ScopeAuditEvent[] = [];
  const broker = new ApprovalBroker((req) => requests.push(req));
  const capture = vi.fn(async () => ({ data: 'aGVsbG8=', mediaType: 'image/png' }));
  const deps: ExecutorDeps = {
    registry: { get: (n) => (n === 'screenshot' ? screenshot : undefined) },
    broker,
    getAutoApprove: () => ({ safe: true, write: true, exec: true }), // 全自動承認でも外部URLは承認必須
    audit: (e) => audits.push(e),
  };
  const ctx: ToolContext = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    log: () => {},
    screenshot: { capture },
  };
  return { deps, requests, audits, broker, capture, ctx };
}

async function respondNext(broker: ApprovalBroker, requests: ApprovalRequestPayload[], decision: 'allow' | 'allow-session' | 'deny'): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
  const last = requests[requests.length - 1];
  if (last) broker.respond(last.id, decision);
}

describe('screenshot × 動的承認(M14-2)', () => {
  it('localhost は autoApprove.safe で承認なしに実行され、audit にも残らない', async () => {
    const { deps, requests, audits, ctx, capture } = setup();
    const r = await executeToolWithApproval(deps, 'screenshot', { url: 'http://localhost:5173/' }, ctx);
    expect(r.isError).not.toBe(true);
    expect(r.images).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(capture).toHaveBeenCalledWith('http://localhost:5173/', undefined, undefined);
  });

  it('外部URLは autoApprove 全ONでも毎回承認+audit記録(approval/result)', async () => {
    const { deps, requests, audits, broker, ctx } = setup();
    const p = executeToolWithApproval(deps, 'screenshot', { url: 'https://example.com/page' }, ctx);
    await respondNext(broker, requests, 'allow');
    const r = await p;
    expect(r.isError).not.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.allowSessionLabel).toBe('example.com');
    expect(requests[0]!.warnings.join()).toContain('example.com');
    expect(audits.map((a) => a.event)).toEqual(['approval', 'result']);
    expect(audits[0]!.paths).toEqual(['https://example.com/page']);
  });

  it('セッション中許可はドメイン単位: 同一ドメインは自動(auditは残る)、別ドメインは再承認', async () => {
    const { deps, requests, audits, broker, ctx } = setup();
    const p1 = executeToolWithApproval(deps, 'screenshot', { url: 'https://example.com/a' }, ctx);
    await respondNext(broker, requests, 'allow-session');
    await p1;

    // 同一ドメイン2回目: ダイアログなし・audit result は記録される
    const before = requests.length;
    const r2 = await executeToolWithApproval(deps, 'screenshot', { url: 'https://example.com/b' }, ctx);
    expect(r2.isError).not.toBe(true);
    expect(requests.length).toBe(before); // 追加の承認なし
    expect(audits.filter((a) => a.event === 'result')).toHaveLength(2);

    // 別ドメイン: 改めて承認が要る(全外部の一括解放はしない)
    const p3 = executeToolWithApproval(deps, 'screenshot', { url: 'https://other.example.org/' }, ctx);
    await respondNext(broker, requests, 'deny');
    const r3 = await p3;
    expect(r3.isError).toBe(true);
    expect(requests.length).toBe(before + 1);
  });

  it('非httpスキームは承認ダイアログも出さず拒否', async () => {
    const { deps, requests, ctx } = setup();
    for (const url of ['file:///C:/Windows/win.ini', 'chrome://settings', 'javascript:alert(1)']) {
      const r = await executeToolWithApproval(deps, 'screenshot', { url }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toContain('拒否');
    }
    expect(requests).toHaveLength(0);
  });

  it('screenshot 未注入コンテキスト(進化ジョブ相当)ではエラー', async () => {
    const { deps, requests, broker, ctx } = setup();
    const bare: ToolContext = { cwd: ctx.cwd, signal: ctx.signal, log: () => {} };
    const p = executeToolWithApproval(deps, 'screenshot', { url: 'https://example.com/' }, bare);
    await respondNext(broker, requests, 'allow');
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未注入');
  });
});
