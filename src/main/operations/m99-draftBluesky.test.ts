import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider } from '../providers/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';

/**
 * M99-14: 「この下書きを今Blueskyへ出す」ボタンの実体。
 * 従来は神議の提案バッチ経由しか投稿経路が無かった(実機で発覚:
 * チャットで承認済みの下書きを手動投稿するしかなかった)。
 * 岩戸ゲートの承認 → 設定メディア付きでAPI投稿 → 下書きをposted化、を固定する。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm99-bsky-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CREDS = JSON.stringify({ identifier: 'me.bsky.social', appPassword: 'xxxx-xxxx-xxxx-xxxx' });

const jsonRes = (data: unknown, ok = true): { ok: boolean; status: number; json(): Promise<unknown> } => ({
  ok,
  status: ok ? 200 : 401,
  json: () => Promise.resolve(data),
});

function mockAtproto(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: { body?: string | Uint8Array; headers?: Record<string, string> }) => {
    if (url.includes('createSession')) return jsonRes({ accessJwt: 'jwt-1', did: 'did:plc:me' });
    if (url.includes('uploadBlob')) {
      return jsonRes({
        blob: { $type: 'blob', ref: { $link: 'bafy1' }, mimeType: init?.headers?.['content-type'], size: 8 },
      });
    }
    if (url.includes('createRecord')) return jsonRes({ uri: 'at://did:plc:me/app.bsky.feed.post/abc' });
    return jsonRes(null, false);
  });
}

function fakeLLM(): LLMProvider {
  return {
    name: 'fake',
    // eslint-disable-next-line @typescript-eslint/require-await
    async *complete() {
      yield { type: 'text_delta', text: '{"analysis":"","paramChanges":[],"proposals":[]}' };
      yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
}

function makeManager(opts: { approve: boolean; mediaPath?: string; fetchImpl: ReturnType<typeof vi.fn> }): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () =>
      ({
        operations: {
          enabled: true,
          repos: [],
          zennSlugs: [],
          ...(opts.mediaPath !== undefined ? { blueskyMediaPath: opts.mediaPath, blueskyMediaAlt: 'デモ' } : {}),
        },
      }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: () => Promise.resolve(opts.approve),
    bandProvider: () => fakeLLM(),
    ghRunner: async () => '',
    getBlueskySecret: () => CREDS,
    fetchImpl: opts.fetchImpl as never,
  });
}

describe('M99-14: draftBlueskyPost', () => {
  it('承認 → 動画付きでAPI投稿され、下書きは posted/bluesky になる', async () => {
    const mediaPath = join(dir, 'demo.mp4');
    writeFileSync(mediaPath, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
    const drafts = new DraftStore(join(dir, 'operations'));
    const [d] = drafts.add([{ kind: 'x-post', title: 'v1.6.0告知', body: '本文です' }]);
    const fetchImpl = mockAtproto();
    const manager = makeManager({ approve: true, mediaPath, fetchImpl });
    await manager.status();

    const r = await manager.draftBlueskyPost(d!.id);
    expect(r.ok, r.detail).toBe(true);

    // 動画としてアップロードされ、embed.videoで投稿された
    const uploadCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('uploadBlob'));
    expect((uploadCall?.[1] as { headers: Record<string, string> }).headers['content-type']).toBe('video/mp4');
    const createCall = fetchImpl.mock.calls.find(([u]) => (u as string).includes('createRecord'));
    const body = JSON.parse((createCall?.[1] as { body: string }).body) as Record<string, unknown>;
    const embed = (body['record'] as Record<string, unknown>)['embed'] as Record<string, unknown>;
    expect(embed['$type']).toBe('app.bsky.embed.video');

    // 下書きはposted化(二重投稿の芽を残さない)
    const after = new DraftStore(join(dir, 'operations')).list().find((x: { id: string }) => x.id === d!.id);
    expect(after?.status).toBe('posted');
    expect(after?.media).toBe('bluesky');
  });

  it('岩戸で却下 → 投稿されず、下書きは draft のまま', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    const [d] = drafts.add([{ kind: 'x-post', title: 't', body: '本文' }]);
    const fetchImpl = mockAtproto();
    const manager = makeManager({ approve: false, fetchImpl });
    await manager.status();

    const r = await manager.draftBlueskyPost(d!.id);
    expect(r.ok).toBe(false);
    expect(fetchImpl.mock.calls.some(([u]) => (u as string).includes('createRecord'))).toBe(false);
    const after = new DraftStore(join(dir, 'operations')).list().find((x: { id: string }) => x.id === d!.id);
    expect(after?.status).toBe('draft');
  });

  it('300字超は岩戸に出す前に拒否(Bluesky上限)', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    const [d] = drafts.add([{ kind: 'x-post', title: 't', body: 'あ'.repeat(301) }]);
    const fetchImpl = mockAtproto();
    const manager = makeManager({ approve: true, fetchImpl });
    await manager.status();

    const r = await manager.draftBlueskyPost(d!.id);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('300字');
    expect(fetchImpl.mock.calls.length).toBe(0);
  });
});
