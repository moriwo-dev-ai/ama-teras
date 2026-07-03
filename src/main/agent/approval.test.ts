import { describe, expect, it } from 'vitest';
import type { ApprovalRequestPayload } from '../../shared/types';
import { ApprovalBroker } from './approval';

function makeBroker(): { broker: ApprovalBroker; requests: ApprovalRequestPayload[] } {
  const requests: ApprovalRequestPayload[] = [];
  return { broker: new ApprovalBroker((req) => requests.push(req)), requests };
}

const payload = (): Omit<ApprovalRequestPayload, 'id'> => ({
  toolName: 'bash',
  risk: 'exec',
  inputPreview: '{}',
  warnings: [],
});

describe('ApprovalBroker', () => {
  it('respond で解決する', async () => {
    const { broker, requests } = makeBroker();
    const p = broker.request(payload());
    broker.respond(requests[0]!.id, 'allow');
    expect(await p).toBe('allow');
  });

  it('未知IDへの respond は無視される', () => {
    const { broker } = makeBroker();
    expect(() => broker.respond('missing', 'allow')).not.toThrow();
  });

  // --- 回帰: signal 対応(指摘#2) ---

  it('待機中に signal が abort されたら deny で解決する', async () => {
    const { broker } = makeBroker();
    const ac = new AbortController();
    const p = broker.request(payload(), ac.signal);
    ac.abort();
    expect(await p).toBe('deny');
  });

  it('既に abort 済みの signal なら即 deny(ダイアログを出さない)', async () => {
    const { broker, requests } = makeBroker();
    const ac = new AbortController();
    ac.abort();
    const p = broker.request(payload(), ac.signal);
    expect(await p).toBe('deny');
    expect(requests).toHaveLength(0);
  });

  it('abort 後に遅れて respond が来ても二重解決しない(最初の deny が有効)', async () => {
    const { broker, requests } = makeBroker();
    const ac = new AbortController();
    const p = broker.request(payload(), ac.signal);
    const id = requests[0]!.id;
    ac.abort();
    broker.respond(id, 'allow'); // 遅延応答は無視される
    expect(await p).toBe('deny');
  });

  it('resetSession は未応答の承認を deny で解決しセッション許可をクリアする', async () => {
    const { broker, requests } = makeBroker();
    const p = broker.request(payload());
    broker.allowForSession('bash');
    expect(broker.isSessionAllowed('bash')).toBe(true);
    broker.resetSession();
    expect(await p).toBe('deny');
    expect(broker.isSessionAllowed('bash')).toBe(false);
    // 解決済みへの respond は無害
    expect(() => broker.respond(requests[0]!.id, 'allow')).not.toThrow();
  });
});
