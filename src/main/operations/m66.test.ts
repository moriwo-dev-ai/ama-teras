import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig, ApprovalBatch } from '../../shared/types';
import { OperationsManager } from './manager';

/**
 * M66: 神議は「zenn記事2本を公開する」を exec-action として提案した。
 * だがZennの公開はアプリには構造的に不可能(published:true は人間の判断)で、
 * この項目には実行内容(action)が付いていない。承認しても何も起きないのに、
 * 返答は「承認を記録した(実行系は岩戸ゲート経由で別途実行)」——押した人は
 * 実行されたと読む。何も起きないなら、起きないと言わせる。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm66-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedBatch(): ApprovalBatch {
  const batch: ApprovalBatch = {
    id: 'b1',
    ts: '2026-07-13T00:00:00Z',
    analysis: '露出ゼロの記事がある',
    items: [
      {
        id: 'i1',
        kind: 'exec-action',
        title: '露出ゼロのzenn記事2本を公開する',
        detail: 'Zennの記事設定で published: true にする',
        status: 'pending',
      },
    ],
  };
  mkdirSync(join(dir, 'operations'), { recursive: true });
  writeFileSync(join(dir, 'operations', 'batches.json'), JSON.stringify([batch]), 'utf8');
  return batch;
}

describe('M66: アプリが実行できない提案を「承認しました」で流さない', () => {
  it('実行内容を持たない exec-action の承認は、人の手が要ると明言する', async () => {
    seedBatch();
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(true),
      bandProvider: () => 'キー未設定',
    });
    await manager.status();

    const r = await manager.batchRespond('b1', 'i1', true);
    expect(r.ok).toBe(true); // エラーではない(承認自体は成立している)
    expect(r.detail).toContain('アプリでは実行できない');
    expect(r.detail).toContain('あなたの手で');
    expect(r.detail).not.toContain('岩戸ゲート経由で別途実行'); // 実行されたと読める言い方をしない
  });
});
