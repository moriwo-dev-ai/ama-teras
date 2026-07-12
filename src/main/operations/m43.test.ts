import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasUnresolvedPlaceholder, repoUrl, resolvePostText } from '../../shared/operations';
import type { AppConfig, IwatoRequestPayload, OperationsConfig } from '../../shared/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';
import { OpsThread } from './thread';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm43-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CREDS = JSON.stringify({ identifier: 'me.bsky.social', appPassword: 'xxxx-xxxx-xxxx-xxxx' });

function makeManager(
  ops: Partial<OperationsConfig>,
  onPrompt: (req: IwatoRequestPayload) => boolean = () => true,
): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () =>
      ({ operations: { enabled: true, repos: [], zennSlugs: [], ...ops } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: (req) => Promise.resolve(onPrompt(req)),
    bandProvider: () => 'キー未設定',
    ghRunner: async () => '',
    getBlueskySecret: () => CREDS,
  });
}

describe('M43-1: {URL} が置換されずに投稿された事故', () => {
  it('プレースホルダを解決する。URLが無ければプレースホルダごと落とす(テンプレを外に出さない)', () => {
    expect(resolvePostText('修正しました {URL} #AMAteras', 'https://github.com/o/r')).toBe(
      '修正しました https://github.com/o/r #AMAteras',
    );
    // URL未設定: 「{URL}」という文字列を出さない。空白も潰す
    expect(resolvePostText('修正しました {URL} #AMAteras', '')).toBe('修正しました #AMAteras');
    expect(repoUrl('moriwo-dev-ai/ama-teras')).toBe('https://github.com/moriwo-dev-ai/ama-teras');
    expect(repoUrl(undefined)).toBe('');
  });

  it('未解決プレースホルダの検出(URLエンコードされた形も含めて呼び出し側でデコードして見る)', () => {
    expect(hasUnresolvedPlaceholder('あああ {URL} いいい')).toBe(true);
    expect(hasUnresolvedPlaceholder('タグ {TAG} を入れて')).toBe(true);
    expect(hasUnresolvedPlaceholder('https://example.com は普通の文')).toBe(false);
    expect(hasUnresolvedPlaceholder('{ url } は小文字なので対象外')).toBe(false);
  });

  it('下書きの読み出しで {URL} が解決される(UIのコピー・リンクも同じ本文になる)', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    drafts.add([{ kind: 'x-post', title: 't', body: '直しました {URL} #AMAteras' }]);
    const manager = makeManager({ repos: ['moriwo-dev-ai/ama-teras'] });
    await manager.status();
    expect(manager.listDrafts()[0]?.body).toBe('直しました https://github.com/moriwo-dev-ai/ama-teras #AMAteras');
  });

  it('プロジェクトURL設定はリポジトリより優先される', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    drafts.add([{ kind: 'x-post', title: 't', body: '見てね {URL}' }]);
    const manager = makeManager({ repos: ['o/r'], projectUrl: 'https://ama-teras.dev' });
    await manager.status();
    expect(manager.listDrafts()[0]?.body).toBe('見てね https://ama-teras.dev');
  });

  it('最後の砦: 未解決のまま実行しようとしても岩戸ゲートに到達しない(承認ダイアログすら出ない)', async () => {
    const prompt = vi.fn(() => true);
    const manager = makeManager({ repos: [] }, prompt);
    await manager.status();
    const r = await manager.execute('bluesky', 'post', 'Bluesky 投稿', '直しました {URL}', {
      text: '直しました {URL}',
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('未解決のプレースホルダ');
    expect(prompt).not.toHaveBeenCalled(); // 承認を求めることすらしない
  });

  it('エンコードされた %7BURL%7D(Xのintentリンク)も止める', async () => {
    const manager = makeManager({ repos: [] });
    await manager.status();
    const r = await manager.execute('x', 'open-intent', 'X 投稿画面', 'text', {
      url: 'https://x.com/intent/post?text=%E7%9B%B4%E3%81%97%E3%81%9F%20%7BURL%7D',
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('未解決のプレースホルダ');
  });
});

describe('M43-2: 同じ下書きが2回投稿された事故(Zenn記事の重複コミット)', () => {
  it('投稿済みの下書きを指す提案は、承認しても実行されない', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    const d = drafts.add([{ kind: 'x-post', title: '幽霊スケジューラ', body: '本文' }])[0]!;
    drafts.update(d.id, { status: 'posted', media: 'bluesky' });

    const prompt = vi.fn(() => true);
    const manager = makeManager({ repos: ['o/r'] }, prompt);
    await manager.status();
    const batch = {
      id: 'b1',
      ts: '2026-07-12T00:00:00.000Z',
      analysis: '',
      items: [
        {
          id: 'i1',
          kind: 'exec-action' as const,
          title: 'Bluesky: 投稿',
          detail: '',
          action: {
            adapterId: 'bluesky',
            actionName: 'post',
            target: 'Bluesky 投稿',
            preview: '本文',
            params: { text: '本文', draftId: d.id },
          },
          status: 'pending' as const,
        },
      ],
    };
    new OpsThread(join(dir, 'operations')).addBatch(batch);

    const single = await manager.batchRespond('b1', 'i1', true);
    expect(single.ok).toBe(false);
    expect(single.detail).toContain('投稿済み');
    expect(prompt).not.toHaveBeenCalled();

    const bulk = await manager.bulkRespond('b1', ['i1'], true);
    expect(bulk.results[0]?.detail).toContain('重複回避');
    expect(prompt).not.toHaveBeenCalled();
  });
});
