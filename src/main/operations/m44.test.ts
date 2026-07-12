import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marksDraftPosted, xIntentUrl, hatenaPanelUrl } from '../../shared/operations';
import type { AppConfig, ApprovalBatch } from '../../shared/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';
import { OpsThread } from './thread';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm44-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BODY = '直しました https://github.com/o/r #AMAteras';

function setup(): { manager: OperationsManager; drafts: DraftStore; draftId: string } {
  const drafts = new DraftStore(join(dir, 'operations'));
  const draftId = drafts.add([{ kind: 'x-post', title: '幽霊スケジューラ', body: BODY }])[0]!.id;
  const manager = new OperationsManager({
    userDataDir: dir,
    getConfig: () =>
      ({ operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: () => Promise.resolve(true),
    bandProvider: () => 'キー未設定',
    ghRunner: async () => '',
  });
  return { manager, drafts, draftId };
}

function batchWith(items: ApprovalBatch['items']): ApprovalBatch {
  return { id: 'b1', ts: '2026-07-12T00:00:00.000Z', analysis: '', items };
}

describe('M44: リンクを開いたら「投稿済み」(下書きが残り続けて二重送信になるのを防ぐ)', () => {
  it('X の一括承認: リンクを返すと同時に下書きを投稿済みにする', async () => {
    const { manager, drafts, draftId } = setup();
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(
      batchWith([
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'X: 投稿画面を開く',
          detail: '',
          action: {
            adapterId: 'x',
            actionName: 'open-intent',
            target: 'X 投稿画面',
            preview: BODY,
            params: { url: xIntentUrl(BODY), draftId },
          },
          status: 'pending',
        },
      ]),
    );

    const r = await manager.bulkRespond('b1', ['i1'], true);
    expect(r.ok).toBe(true);
    expect(r.links?.[0]?.url).toContain('x.com/intent/post');
    const d = drafts.list().find((x) => x.id === draftId);
    expect(d?.status).toBe('posted');
    expect(d?.media).toBe('x');
  });

  it('二度目の一括承認は実行されない(M43-2のガードが効き、リンクも返らない)', async () => {
    const { manager, drafts, draftId } = setup();
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(
      batchWith([
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'X: 投稿画面を開く',
          detail: '',
          action: {
            adapterId: 'x',
            actionName: 'open-intent',
            target: 'X 投稿画面',
            preview: BODY,
            params: { url: xIntentUrl(BODY), draftId },
          },
          status: 'pending',
        },
      ]),
    );
    await manager.bulkRespond('b1', ['i1'], true);

    const again = await manager.bulkRespond('b1', ['i1'], true);
    expect(again.links ?? []).toHaveLength(0);
    expect(again.results[0]?.detail).toContain('重複回避');
    expect(drafts.list().find((x) => x.id === draftId)?.media).toBe('x'); // 上書きもされない
  });

  it('はてブは投稿済みにしない(同じ下書きのX投稿を「済み」で消してしまわない)', async () => {
    expect(marksDraftPosted('x')).toBe(true);
    expect(marksDraftPosted('bluesky')).toBe(true);
    expect(marksDraftPosted('hatena')).toBe(false);

    const { manager, drafts, draftId } = setup();
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(
      batchWith([
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'はてブ: 追加画面を開く',
          detail: '',
          action: {
            adapterId: 'hatena',
            actionName: 'add',
            target: 'はてブ追加画面',
            preview: 'https://github.com/o/r',
            params: { url: hatenaPanelUrl('https://github.com/o/r'), draftId },
          },
          status: 'pending',
        },
      ]),
    );

    const r = await manager.bulkRespond('b1', ['i1'], true);
    expect(r.ok).toBe(true);
    expect(drafts.list().find((x) => x.id === draftId)?.status).toBe('draft'); // まだXへ出せる
  });

  it('取り消せる: 未投稿に戻すと、また行き先へ出せる(Xの Post を押さなかった場合)', async () => {
    const { manager, draftId } = setup();
    await manager.status();
    manager.updateDraft(draftId, { status: 'posted', media: 'x' });
    expect(manager.listDrafts().find((d) => d.id === draftId)?.status).toBe('posted');

    manager.updateDraft(draftId, { status: 'draft' });
    expect(manager.listDrafts().find((d) => d.id === draftId)?.status).toBe('draft');
  });
});
