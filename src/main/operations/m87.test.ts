import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';

/**
 * M87: v1.2.0 を**実際に公開した**のに、台帳は「公開待ち」のままだった。
 * Zennで直したのと同じ病気(M76/M78)がリリース側に残っていた — というより、そもそも
 * **どの下書きがどのリリースなのか、突き合わせる鍵が無かった**。
 * 下書きにタグを憶えさせ、gh の返す一次情報(draft=false=世に出ている)で台帳を書き直す。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm87-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(releases: { tagName: string; isDraft: boolean }[]): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () => ({ operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: () => Promise.resolve(true),
    bandProvider: () => 'キー未設定',
    ghRunner: async (args) => (args.includes('list') ? JSON.stringify(releases) : ''),
  });
}

describe('M87: 公開したリリースを、台帳が「公開待ち」と言い続けない', () => {
  it('gh が draft=false と言うなら、その下書きは posted になる', async () => {
    const manager = setup([{ tagName: 'v1.2.0', isDraft: false }]);
    await manager.status();
    const store = new DraftStore(join(dir, 'operations'));
    const d = store.add([{ kind: 'release-note', title: 'ノート', body: '' }])[0]!;
    manager.updateDraft(d.id, { status: 'staged', media: 'github', tag: 'v1.2.0' });

    await manager.publishState(); // 一次情報を引くと、台帳が直る

    expect(manager.listDrafts().find((x) => x.id === d.id)?.status).toBe('posted');
  });

  it('まだ draft のリリースは「公開待ち」に戻す(出したつもりを posted にしない)', async () => {
    const manager = setup([{ tagName: 'v9.9.9', isDraft: true }]);
    await manager.status();
    const store = new DraftStore(join(dir, 'operations'));
    const d = store.add([{ kind: 'release-note', title: 'ノート', body: '' }])[0]!;
    manager.updateDraft(d.id, { status: 'posted', media: 'github', tag: 'v9.9.9' });

    await manager.publishState();

    expect(manager.listDrafts().find((x) => x.id === d.id)?.status).toBe('staged');
  });

  it('ghからリリースが引けないときは、憶測で状態を倒さない', async () => {
    const manager = setup([]); // そのタグは返ってこない
    await manager.status();
    const store = new DraftStore(join(dir, 'operations'));
    const d = store.add([{ kind: 'release-note', title: 'ノート', body: '' }])[0]!;
    manager.updateDraft(d.id, { status: 'staged', media: 'github', tag: 'v1.2.0' });

    await manager.publishState();

    expect(manager.listDrafts().find((x) => x.id === d.id)?.status).toBe('staged');
  });
});
