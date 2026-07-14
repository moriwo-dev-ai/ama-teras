import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig, ApprovalBatch } from '../../shared/types';
import { OperationsManager } from './manager';
import { OpsThread } from './thread';

/**
 * M80: **スマホからは「アプリが実行できない提案(exec-action)」を一枚も片付けられなかった**。
 * bulkRespond が action を持つカードだけを対象にしていたため、そういうカードばかりのバッチを
 * 一括却下すると「対象項目が無い」で終わり、カードは pending のまま残り続けた
 * (スマホの承認・却下は1枚でも全部 bulkRespond を通る)。
 * 実行できないことと、判断を記録できないことは別。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm80-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BATCH: ApprovalBatch = {
  id: 'b1',
  ts: '2026-07-14T00:00:00.000Z',
  analysis: '',
  items: [
    { id: 'i1', kind: 'exec-action', title: '記事の同期状態を確認', detail: '人間の手が要る', status: 'pending' },
    { id: 'i2', kind: 'exec-action', title: '別の手作業', detail: '人間の手が要る', status: 'pending' },
  ],
};

function setup(): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () => ({ operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: () => Promise.resolve(true),
    bandProvider: () => 'キー未設定',
    ghRunner: async () => '',
  });
}

describe('M80: 一括却下は「アプリが実行できない提案」も片付ける', () => {
  it('exec-actionだけのバッチを一括却下できる(「対象項目が無い」で終わらない)', async () => {
    const manager = setup();
    await manager.status();
    const thread = new OpsThread(join(dir, 'operations'));
    thread.addBatch(BATCH);

    const r = await manager.bulkRespond('b1', ['i1', 'i2'], false);

    expect(r.ok).toBe(true);
    expect(r.detail).toContain('2件');
    const after = new OpsThread(join(dir, 'operations')).getBatch('b1');
    expect(after?.items.every((i) => i.status !== 'pending')).toBe(true);
  });
});
