import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';

/**
 * M85: リリースノートの下書きを「公開待ち(staged)」にしようとしても、**黙って無視されていた**。
 * IPC の許可リストが draft/posted/discarded しか知らず(M57で足した staged を知らない)、
 * 知らない値を**エラーにもせず捨てて**いたため、更新は成功したように見えて何も変わらない。
 * 黙って落とすのが一番たちが悪い。ここでは受け口(updateDraft)が staged を通すことを固定する。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm85-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('M85: 「公開待ち」を書けること', () => {
  it('下書きを staged にできる(出す準備はできたが、まだ誰も読めない状態)', async () => {
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(true),
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '',
    });
    await manager.status();

    const store = new DraftStore(join(dir, 'operations'));
    const created = store.add([{ kind: 'release-note', title: 'v1.2.0', body: 'ノート' }])[0]!;

    const updated = manager.updateDraft(created.id, { status: 'staged', media: 'github' });

    expect(updated?.status).toBe('staged');
    expect(manager.listDrafts().find((d) => d.id === created.id)?.status).toBe('staged');
  });
});
