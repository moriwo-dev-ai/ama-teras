import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ApprovalBatch } from '../../shared/types';
import {
  BlueskyWriter,
  createBlueskyAdapter,
  parseBlueskyCredentials,
} from './adapters/bluesky';
import { OperationsManager } from './manager';
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
  return vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes('createSession')) return jsonRes({ accessJwt: 'jwt-1', did: 'did:plc:me' });
    if (url.includes('resolveHandle')) return jsonRes({ did: 'did:plc:alice' });
    if (url.includes('createRecord')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
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
