import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ApprovalBatch } from '../../shared/types';
import {
  BlueskyWriter,
  createBlueskyAdapter,
  parseBlueskyCredentials,
} from './adapters/bluesky';
import { CandidateStore } from './amenoUzume';
import { OperationsManager } from './manager';
import type { LLMProvider } from '../providers/types';
import { OpsThread } from './thread';

/**
 * M35-4: Bluesky実行系。
 * 鉄則の固定: 実行(post/follow/reply)は岩戸ゲート経由のみ。資格情報が無ければ
 * 宣言(capabilities.execute)ごと空=提案のみ(宣言と実挙動の一致)。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bsky-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CREDS = JSON.stringify({ identifier: 'moriwo.bsky.social', appPassword: 'aaaa-bbbb-cccc-dddd' });

const jsonRes = (data: unknown, ok = true): { ok: boolean; status: number; json(): Promise<unknown> } => ({
  ok,
  status: ok ? 200 : 401,
  json: () => Promise.resolve(data),
});

function mockAtproto(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: { body?: string | Uint8Array; headers?: Record<string, string> }) => {
    if (url.includes('createSession')) return jsonRes({ accessJwt: 'jwt-1', did: 'did:plc:me' });
    if (url.includes('resolveHandle')) return jsonRes({ did: 'did:plc:alice' });
    if (url.includes('uploadBlob')) {
      const bytes = init?.body as Uint8Array | undefined;
      return jsonRes({
        blob: {
          $type: 'blob',
          ref: { $link: 'bafyreitest123' },
          mimeType: init?.headers?.['content-type'],
          size: bytes?.byteLength ?? 0,
        },
      });
    }
    if (url.includes('createRecord')) {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return jsonRes({ uri: `at://did:plc:me/${String(body['collection'])}/abc` });
    }
    if (url.includes('getPosts')) {
      return jsonRes({ posts: [{ uri: 'at://did:plc:alice/app.bsky.feed.post/p1', cid: 'cid-1', record: {} }] });
    }
    return jsonRes(null, false);
  });
}

describe('M35-4: 資格情報と宣言の一致', () => {
  it('parseBlueskyCredentials: 正常JSON / 欠落 / 壊れたJSON', () => {
    expect(parseBlueskyCredentials(CREDS)).toEqual({ identifier: 'moriwo.bsky.social', appPassword: 'aaaa-bbbb-cccc-dddd' });
    expect(parseBlueskyCredentials(JSON.stringify({ identifier: 'x' }))).toBeNull();
    expect(parseBlueskyCredentials('ぐちゃぐちゃ')).toBeNull();
    expect(parseBlueskyCredentials(null)).toBeNull();
  });

  it('資格情報なし: execute空+executorなし / あり: post/follow/reply+executor', () => {
    const without = createBlueskyAdapter(null);
    expect(without.capabilities.execute).toEqual([]);
    expect(without.executor).toBeUndefined();
    const withCreds = createBlueskyAdapter(parseBlueskyCredentials(CREDS));
    expect(withCreds.capabilities.execute).toEqual(['post', 'follow', 'reply']);
    expect(withCreds.executor).toBeDefined();
  });
});

describe('M35-4: BlueskyWriter(ATプロトコルのリクエスト形状・実発行なし=全てモック)', () => {
  it('follow: resolveHandle→createSession→graph.followレコード', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    const result = await writer.follow('@alice.bsky.social');
    expect(result).toContain('alice.bsky.social をフォローした');
    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const body = JSON.parse((createCall?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body['collection']).toBe('app.bsky.graph.follow');
    expect((body['record'] as Record<string, unknown>)['subject']).toBe('did:plc:alice');
    // 認証ヘッダが付く
    expect((createCall?.[1] as { headers: Record<string, string> }).headers['authorization']).toBe('Bearer jwt-1');
  });

  it('post: feed.postレコード(300字に切り詰め)', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    await writer.post('a'.repeat(400));
    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const body = JSON.parse((createCall?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body['collection']).toBe('app.bsky.feed.post');
    expect(String((body['record'] as Record<string, unknown>)['text'])).toHaveLength(300);
  });

  it('post: mediaPath未指定は従来どおりembedなし(リグレッションなし)', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    await writer.post('hello bluesky');
    // uploadBlobは一切呼ばれない
    expect(fetchImpl.mock.calls.some(([u]) => (u as string).includes('uploadBlob'))).toBe(false);
    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const body = JSON.parse((createCall?.[1] as { body: string }).body) as Record<string, unknown>;
    const record = body['record'] as Record<string, unknown>;
    expect(record['$type']).toBe('app.bsky.feed.post');
    expect(record['text']).toBe('hello bluesky');
    expect(record['embed']).toBeUndefined();
    expect(Object.keys(record).sort()).toEqual(['$type', 'createdAt', 'text']);
  });

  it('post: 画像添付でuploadBlob→createRecordのembedに反映される', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    const gifPath = join(dir, 'cat.gif');
    const gifBytes = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    writeFileSync(gifPath, gifBytes);

    const result = await writer.post('look at this', gifPath, 'a cat gif');
    expect(result).toContain('投稿した');

    // 1) uploadBlobが正しいヘッダ・ボディで呼ばれた
    const uploadCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('uploadBlob'));
    expect(uploadCall).toBeDefined();
    expect((uploadCall?.[0] as string)).toContain('/xrpc/com.atproto.repo.uploadBlob');
    const uploadInit = uploadCall?.[1] as { headers: Record<string, string>; body: Uint8Array };
    expect(uploadInit.headers['authorization']).toBe('Bearer jwt-1');
    expect(uploadInit.headers['content-type']).toBe('image/gif');
    expect(Buffer.from(uploadInit.body)).toEqual(gifBytes);

    // 2) createRecordのrecordにembedが付く
    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const body = JSON.parse((createCall?.[1] as { body: string }).body) as Record<string, unknown>;
    const record = body['record'] as Record<string, unknown>;
    expect(record['embed']).toEqual({
      $type: 'app.bsky.embed.images',
      images: [
        {
          image: {
            $type: 'blob',
            ref: { $link: 'bafyreitest123' },
            mimeType: 'image/gif',
            size: gifBytes.byteLength,
          },
          alt: 'a cat gif',
        },
      ],
    });
  });

  it('post: mp4は動画としてembed.videoで添付される(画像GIFは静止画化されるため)', async () => {
    // M99-12: 実機でGIFを画像添付したら静止画になった。動画は app.bsky.embed.video が正
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    const mp4Path = join(dir, 'demo.mp4');
    const mp4Bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    writeFileSync(mp4Path, mp4Bytes);

    const result = await writer.post('デモ動画', mp4Path, 'AMA-terasのデモ');
    expect(result).toContain('投稿した');

    const uploadCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('uploadBlob'));
    expect((uploadCall?.[1] as { headers: Record<string, string> }).headers['content-type']).toBe('video/mp4');

    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const body = JSON.parse((createCall?.[1] as { body: string }).body) as Record<string, unknown>;
    const embed = (body['record'] as Record<string, unknown>)['embed'] as Record<string, unknown>;
    expect(embed['$type']).toBe('app.bsky.embed.video');
    expect(embed['alt']).toBe('AMA-terasのデモ');
    expect((embed['video'] as Record<string, unknown>)['mimeType']).toBe('video/mp4');
    // images形式ではない
    expect(embed['images']).toBeUndefined();
  });

  it('post: 動画は20MB超で明示エラー(画像の1MB制限は適用しない)', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    // 1MB超・20MB未満の動画は通る(画像の上限を誤適用しない)
    const okPath = join(dir, 'ok.mp4');
    writeFileSync(okPath, Buffer.alloc(1_500_000));
    await expect(writer.post('動画', okPath, '')).resolves.toContain('投稿した');
    // 20MB超は事前に弾く
    const bigPath = join(dir, 'big.mp4');
    writeFileSync(bigPath, Buffer.alloc(20_000_001));
    await expect(writer.post('動画', bigPath, '')).rejects.toThrow(/動画サイズ.*超過/);
  });

  it('post: 画像サイズが1,000,000バイト超はuploadBlob前に明示エラー', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    const bigPath = join(dir, 'big.png');
    writeFileSync(bigPath, Buffer.alloc(1_000_001));
    await expect(writer.post('big', bigPath)).rejects.toThrow(/上限/);
    // 上限超過はアップロード前に弾かれる(uploadBlobは呼ばれない)
    expect(fetchImpl.mock.calls.some(([u]) => (u as string).includes('uploadBlob'))).toBe(false);
  });

  it('post: 未知の拡張子は明示的にエラー', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    const docPath = join(dir, 'file.pdf');
    writeFileSync(docPath, Buffer.from('dummy'));
    await expect(writer.post('doc', docPath)).rejects.toThrow(/unsupported media type/);
    // 拡張子エラーはuploadBlob/createRecordより前(loginは通っても添付処理には進まない)
    expect(fetchImpl.mock.calls.some(([u]) => (u as string).includes('uploadBlob'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([u]) => (u as string).includes('createRecord'))).toBe(false);
  });

  it('reply: 親のuri/cidを取得してreply参照を付ける', async () => {
    const fetchImpl = mockAtproto();
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    await writer.reply('いい実験ですね', 'at://did:plc:alice/app.bsky.feed.post/p1');
    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const record = (JSON.parse((createCall?.[1] as { body: string }).body) as { record: Record<string, unknown> }).record;
    expect(record['reply']).toEqual({
      root: { uri: 'at://did:plc:alice/app.bsky.feed.post/p1', cid: 'cid-1' },
      parent: { uri: 'at://did:plc:alice/app.bsky.feed.post/p1', cid: 'cid-1' },
    });
  });

  it('認証失敗はexecutorまで例外で伝わる(静かに成功扱いしない)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(null, false));
    const writer = new BlueskyWriter(parseBlueskyCredentials(CREDS)!, fetchImpl);
    await expect(writer.post('x')).rejects.toThrow(/認証失敗/);
  });
});

describe('M35-4: executor経由のmediaPath/mediaAlt受け渡し', () => {
  it('executor({action:"post", params:{text,mediaPath,mediaAlt}}) がwriter.postへ渡る', async () => {
    const fetchImpl = mockAtproto();
    const adapter = createBlueskyAdapter(parseBlueskyCredentials(CREDS), fetchImpl);
    const photoPath = join(dir, 'photo.png');
    writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const detail = await adapter.executor!('post', { text: 'hi', mediaPath: photoPath, mediaAlt: 'a photo' });
    expect(detail).toContain('投稿した');

    const uploadCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('uploadBlob'));
    expect(uploadCall).toBeDefined();
    expect((uploadCall?.[1] as { headers: Record<string, string> }).headers['content-type']).toBe('image/png');

    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const body = JSON.parse((createCall?.[1] as { body: string }).body) as Record<string, unknown>;
    const record = body['record'] as Record<string, unknown>;
    const embed = record['embed'] as { images: { alt: string }[] };
    expect(embed.images[0]!.alt).toBe('a photo');
  });
});

describe('M35-4: 承認バッチ→岩戸ゲート→実行の結線', () => {
  it('exec-action(フォロー提案)の承認が岩戸ゲート(最終確認)を通って実行される', async () => {
    const fetchImpl = mockAtproto();
    const approvals: string[] = [];
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: (req) => {
        approvals.push(`${req.adapterId}:${req.action}:${req.target}`);
        return Promise.resolve(true);
      },
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '[]',
      fetchImpl,
      getBlueskySecret: () => CREDS,
    });
    await manager.status(); // 初期化

    // 神議が作ったのと同形のバッチを直接投函(LLM非依存でテスト)
    const batch: ApprovalBatch = {
      id: 'b1',
      ts: new Date().toISOString(),
      analysis: 'test',
      items: [
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'Bluesky: @alice.bsky.social をフォロー(仲間候補)',
          detail: '自作公開あり',
          action: {
            adapterId: 'bluesky',
            actionName: 'follow',
            target: '@alice.bsky.social',
            preview: 'Blueskyで @alice.bsky.social をフォローする',
            params: { handle: 'alice.bsky.social' },
          },
          status: 'pending',
        },
      ],
    };
    new OpsThread(join(dir, 'operations')).addBatch(batch);

    const result = await manager.batchRespond('b1', 'i1', true);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('フォローした');
    // 岩戸ゲートの承認プロンプトを必ず通った(バッチ承認だけでは実行されない)
    expect(approvals).toEqual(['bluesky:follow:@alice.bsky.social']);
    // 実際のフォローAPIが呼ばれた(モック)
    expect(fetchImpl.mock.calls.some(([u]) => (u as string).includes('graph') || (u as string).includes('createRecord'))).toBe(true);
  });

  it('岩戸ゲートで拒否されたらAPIは呼ばれない', async () => {
    const fetchImpl = mockAtproto();
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false), // 岩戸で拒否
      bandProvider: () => 'キー未設定',
      ghRunner: async () => '[]',
      fetchImpl,
      getBlueskySecret: () => CREDS,
    });
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch({
      id: 'b2',
      ts: new Date().toISOString(),
      analysis: 't',
      items: [
        {
          id: 'i2',
          kind: 'exec-action',
          title: 'follow',
          detail: '',
          action: { adapterId: 'bluesky', actionName: 'follow', target: '@x', preview: 'p', params: { handle: 'x' } },
          status: 'pending',
        },
      ],
    });
    const result = await manager.batchRespond('b2', 'i2', true);
    expect(result.ok).toBe(false);
    expect(fetchImpl.mock.calls.some(([u]) => (u as string).includes('createSession'))).toBe(false);
  });
});

/**
 * M99-15: 「残す」の罠の解消。
 * フォロー提案が new のみ対象だったため、「残す(kept)」を押した人が永遠に提案から
 * 外れていた(実機で5人が塩漬け)。さらに巡回が自分の投稿を拾い「自分をフォローする」
 * 提案まで出した。kept込み・自分除外・実行済み(followed)の再提案なし、を固定する。
 */
describe('M99-15: フォロー提案の対象と実行後の記録', () => {
  function managerWith(candidateSeeds: { profile: string; status: 'new' | 'kept' | 'discarded' | 'followed' }[]): {
    manager: OperationsManager;
    store: CandidateStore;
  } {
    const store = new CandidateStore(join(dir, 'operations'));
    for (const seed of candidateSeeds) {
      const c = store.add({ source: 'bluesky:test', profile: seed.profile, verdict: 'match', reasons: ['理由'] });
      if (seed.status !== 'new') store.resolve(c.id, seed.status as 'kept' | 'discarded' | 'followed');
    }
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(true),
      bandProvider: () => fakeKamuhakariProvider(),
      ghRunner: async () => '[]',
      fetchImpl: mockAtproto(),
      getBlueskySecret: () => CREDS,
    });
    return { manager, store };
  }

  function fakeKamuhakariProvider(): LLMProvider {
    const out = JSON.stringify({ analysis: 'x', paramChanges: [], proposals: [] });
    return {
      name: 'fake',
      // eslint-disable-next-line @typescript-eslint/require-await
      async *complete() {
        yield { type: 'text_delta', text: out };
        yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as LLMProvider;
  }

  it('kept も提案対象になり、自分自身と followed は提案されない', async () => {
    const { manager } = managerWith([
      { profile: '@alice.bsky.social (新規の人)', status: 'new' },
      { profile: '@bob.bsky.social (残した人)', status: 'kept' },
      { profile: '@moriwo.bsky.social (自分)', status: 'new' }, // CREDS の identifier と同一
      { profile: '@carol.bsky.social (実行済み)', status: 'followed' },
      { profile: '@dave.bsky.social (破棄済み)', status: 'discarded' },
    ]);
    await manager.status();
    const { batch } = await manager.runKamuhakari();
    const titles = (batch?.items ?? []).filter((i) => i.title.includes('フォロー')).map((i) => i.title);
    expect(titles).toContain('Bluesky: @alice.bsky.social をフォロー(仲間候補)');
    expect(titles).toContain('Bluesky: @bob.bsky.social をフォロー(仲間候補)'); // kept が対象になった
    expect(titles.some((t) => t.includes('moriwo.bsky.social'))).toBe(false); // 自分は出ない
    expect(titles.some((t) => t.includes('carol'))).toBe(false); // 実行済みは出ない
    expect(titles.some((t) => t.includes('dave'))).toBe(false);
  });

  it('フォロー実行に成功した候補は followed になる(再提案が止まる)', async () => {
    const { manager, store } = managerWith([{ profile: '@alice.bsky.social (新規)', status: 'new' }]);
    await manager.status();
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.title.includes('フォロー'));
    expect(item).toBeDefined();

    const r = await manager.batchRespond(batch!.id, item!.id, true);
    expect(r.ok, r.detail).toBe(true);
    const after = store.list().find((c) => c.profile.includes('alice'));
    expect(after?.status).toBe('followed');

    // 次の神議では再提案されない
    const second = await manager.runKamuhakari();
    const again = (second.batch?.items ?? []).filter((i) => i.title.includes('フォロー'));
    expect(again).toHaveLength(0);
  });
});

describe('M99-15: 実フォロー状態との突き合わせ', () => {
  it('Bluesky実態でフォロー済みの候補は提案せず、台帳をfollowedへ同期する', async () => {
    const store = new CandidateStore(join(dir, 'operations'));
    store.add({ source: 'bluesky:t', profile: '@bob.bsky.social (既フォロー)', verdict: 'match', reasons: ['r'] });
    store.add({ source: 'bluesky:t', profile: '@alice.bsky.social (未フォロー)', verdict: 'match', reasons: ['r'] });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('getFollows')) return jsonRes({ follows: [{ handle: 'bob.bsky.social' }] });
      return jsonRes(null, false);
    });
    const out = JSON.stringify({ analysis: 'x', paramChanges: [], proposals: [] });
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(true),
      bandProvider: () =>
        ({
          name: 'fake',
          // eslint-disable-next-line @typescript-eslint/require-await
          async *complete() {
            yield { type: 'text_delta', text: out };
            yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 } };
          },
        }) as unknown as LLMProvider,
      ghRunner: async () => '[]',
      fetchImpl: fetchImpl as never,
      getBlueskySecret: () => CREDS,
    });
    await manager.status();
    const { batch } = await manager.runKamuhakari();
    const titles = (batch?.items ?? []).filter((i) => i.title.includes('フォロー')).map((i) => i.title);
    expect(titles).toEqual(['Bluesky: @alice.bsky.social をフォロー(仲間候補)']);
    // 台帳が実態に同期された
    expect(store.list().find((c) => c.profile.includes('bob'))?.status).toBe('followed');
  });
});
