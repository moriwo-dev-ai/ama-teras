import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig, ApprovalBatch } from '../../shared/types';
import type { LLMProvider } from '../providers/types';
import { OperationsManager } from './manager';

/**
 * M68: 神議は15分ごとに、まだ誰も承認していない同じカードを作り直していた。
 * 実機で未処理54枚のうち、同一タイトルのカードが3種×8枚。承認画面(特にスマホ)が
 * 埋まり、本当に見るべきものが埋もれる。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm68-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 神議のLLM: 同じ提案を毎回返す(実機で起きていたこと) */
function fakeProvider(): LLMProvider {
  const output = JSON.stringify({
    analysis: '公開待ちが滞留している',
    paramChanges: [],
    proposals: [{ kind: 'exec-action', title: 'Zenn記事化: 「動いた」と報告していたAI', detail: '記事にする' }],
  });
  return {
    name: 'fake',
    // eslint-disable-next-line @typescript-eslint/require-await
    async *complete() {
      yield { type: 'text_delta', text: output };
      yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
}

function pendingTitles(): string[] {
  const raw: ApprovalBatch[] = JSON.parse(readFileSync(join(dir, 'operations', 'batches.json'), 'utf8'));
  return raw.flatMap((b) => b.items).filter((i) => i.status === 'pending').map((i) => i.title);
}

describe('M68: 承認待ちに同じカードを積み増さない', () => {
  it('2回続けて同じ提案が出ても、未処理カードは1枚のまま', async () => {
    mkdirSync(join(dir, 'operations'), { recursive: true });
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => fakeProvider(),
    });
    await manager.status();

    await manager.runKamuhakari();
    expect(pendingTitles()).toHaveLength(1);

    await manager.runKamuhakari();
    // 2回目は同じカードなので積み増さない(実機では8枚まで増えていた)
    expect(pendingTitles()).toHaveLength(1);
  });

  it('M69: すでに積み上がった同一カードは、1枚への回答が双子にも及ぶ', async () => {
    // M68以前の状態を再現: まったく同じカードが3枚、別バッチに未処理で載っている
    const item = (id: string) => ({
      id,
      kind: 'exec-action' as const,
      title: '同じ提案',
      detail: 'd',
      status: 'pending' as const,
    });
    const batches: ApprovalBatch[] = [
      { id: 'b1', ts: '2026-07-13T00:00:00Z', analysis: 'a', items: [item('i1')] },
      { id: 'b2', ts: '2026-07-13T00:15:00Z', analysis: 'a', items: [item('i2')] },
      { id: 'b3', ts: '2026-07-13T00:30:00Z', analysis: 'a', items: [item('i3')] },
    ];
    mkdirSync(join(dir, 'operations'), { recursive: true });
    writeFileSync(join(dir, 'operations', 'batches.json'), JSON.stringify(batches), 'utf8');

    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false),
      bandProvider: () => fakeProvider(),
    });
    await manager.status();

    const r = await manager.batchRespond('b1', 'i1', false);
    expect(r.detail).toContain('2枚も却下');
    expect(pendingTitles()).toHaveLength(0); // 同じ画面を3回押させない
  });
});
