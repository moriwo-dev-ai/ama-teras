import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig, OperationsConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';

/** 神議が何も提案しないダミーLLM(analysisだけ返す) */
function kamuhakariLLM(): LLMProvider {
  const out = JSON.stringify({ analysis: '観測は横ばい', paramChanges: [], proposals: [] });
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta', text: out };
      yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' } as ProviderEvent;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm92-bsky-media-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CREDS = JSON.stringify({ identifier: 'me.bsky.social', appPassword: 'xxxx-xxxx-xxxx-xxxx' });

function makeManager(ops: Partial<OperationsConfig>, workspace?: string): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () =>
      ({
        operations: { enabled: true, repos: [], zennSlugs: [], ...ops },
        ...(workspace !== undefined ? { workspace } : {}),
      }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: () => Promise.resolve(true),
    bandProvider: () => kamuhakariLLM(),
    ghRunner: async () => '',
    getBlueskySecret: () => CREDS,
  });
}

describe('第2段: Bluesky投稿へのGIF/画像添付の配線', () => {
  it('blueskyMediaPath 設定時: paramsにmediaPath(絶対パス)・mediaAltが入り、previewに「添付:」が付く', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    drafts.add([{ kind: 'x-post', title: 'お知らせ', body: '本文です' }]);
    const manager = makeManager(
      { blueskyMediaPath: 'docs/demo.gif', blueskyMediaAlt: 'デモGIF' },
      'C:\\work\\proj',
    );
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.action?.adapterId === 'bluesky' && i.action.actionName === 'post');
    expect(item).toBeDefined();
    const params = item?.action?.params as Record<string, unknown>;
    expect(params['mediaPath']).toBe(join('C:\\work\\proj', 'docs/demo.gif'));
    expect(params['mediaAlt']).toBe('デモGIF');
    expect(item?.action?.preview).toContain('添付: ');
    expect(item?.action?.preview).toContain(join('C:\\work\\proj', 'docs/demo.gif'));
  });

  it('未設定時: params に mediaPath キーが無い(従来と完全同一)', async () => {
    const drafts = new DraftStore(join(dir, 'operations'));
    drafts.add([{ kind: 'x-post', title: 'お知らせ', body: '本文です' }]);
    const manager = makeManager({});
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.action?.adapterId === 'bluesky' && i.action.actionName === 'post');
    expect(item).toBeDefined();
    const params = item?.action?.params as Record<string, unknown>;
    expect('mediaPath' in params).toBe(false);
    expect('mediaAlt' in params).toBe(false);
    expect(item?.action?.preview).toBe('本文です');
  });
});
