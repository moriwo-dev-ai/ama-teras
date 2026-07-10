import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../providers/types';
import {
  evictOldImagesOverLimit,
  SESSION_SCHEMA_VERSION,
  SessionStore,
  type SessionData,
} from './sessions';

/** M14-1: 画像のblob外出し・50MB上限・欠損耐性を固定する */

const ID = '11111111-1111-1111-1111-111111111111';
const PNG_DATA = Buffer.from('fake-png-bytes').toString('base64');

function dataOf(overrides: Partial<SessionData>): SessionData {
  return {
    version: SESSION_SCHEMA_VERSION,
    id: ID,
    title: 't',
    workspace: 'C:\\ws',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:01:00.000Z',
    history: [],
    ...overrides,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-img-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('SessionStore × 画像blob(M14-1)', () => {
  it('保存で画像本体が blobs/ へ外出しされ、JSONにはbase64が残らず、ロードで復元される', async () => {
    const store = new SessionStore(dir);
    const history: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'これ見て' },
          { type: 'image', mediaType: 'image/png', data: PNG_DATA, description: 'モック' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 't1',
            content: '撮影',
            images: [{ mediaType: 'image/png', data: PNG_DATA }],
          },
        ],
      },
    ];
    await store.save(dataOf({ history }));

    // JSON本体には base64 が入っていない(blobRef参照)
    const raw = await readFile(join(dir, `${ID}.json`), 'utf8');
    expect(raw).not.toContain(PNG_DATA);
    expect(raw).toContain('blobRef');
    const blobs = await readdir(join(dir, 'blobs'));
    expect(blobs).toHaveLength(1); // 同一内容はcontent-addressedで1つ

    // live履歴は破壊されていない(base64のまま使える)
    const liveImg = history[0]!.content[1]!;
    expect(liveImg.type === 'image' && liveImg.data).toBe(PNG_DATA);

    // ロードで画像が復元される
    const loaded = await store.load(ID);
    const img = loaded!.history[0]!.content[1]!;
    expect(img.type === 'image' && img.data).toBe(PNG_DATA);
    const tr = loaded!.history[2]!.content[0]!;
    expect(tr.type === 'tool_result' && tr.images![0]!.data).toBe(PNG_DATA);
  });

  it('blob が欠損していてもロードは壊れず、置換テキストになる', async () => {
    const store = new SessionStore(dir);
    await store.save(
      dataOf({
        history: [
          { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: PNG_DATA, description: 'x' }] },
        ],
      }),
    );
    await rm(join(dir, 'blobs'), { recursive: true, force: true });
    const loaded = await store.load(ID);
    const block = loaded!.history[0]!.content[0]!;
    expect(block.type).toBe('text');
    expect(block.type === 'text' && block.text).toContain('本体が見つからない');
  });

  it('テキストのみの既存セッションはそのまま読める(後方互換)', async () => {
    const store = new SessionStore(dir);
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'こんにちは' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'やあ' }] },
    ];
    await store.save(dataOf({ history }));
    const loaded = await store.load(ID);
    expect(loaded!.history).toEqual(history);
  });
});

describe('evictOldImagesOverLimit(50MB上限)', () => {
  it('上限超過で古い画像からテキスト化され、ブロック数・ペア構造は不変', () => {
    const big = (n: number): string => Buffer.alloc(n, 1).toString('base64');
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: big(600), description: '古い' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 's', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'r', images: [{ mediaType: 'image/png', data: big(600) }] },
        ],
      },
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: big(600), description: '新しい' }] },
    ];
    const blocksBefore = history.map((m) => m.content.length);

    // 上限=1000bytes: 3枚(各600B)中、古い2枚が落ちて新しい1枚が残る
    const evicted = evictOldImagesOverLimit(history, 1000);
    expect(evicted).toBe(2);
    expect(history.map((m) => m.content.length)).toEqual(blocksBefore);

    const first = history[0]!.content[0]!;
    expect(first.type).toBe('text');
    expect(first.type === 'text' && first.text).toContain('保存上限で破棄');
    const tr = history[2]!.content[0]!;
    expect(tr.type === 'tool_result' && tr.images).toBeUndefined();
    expect(tr.type === 'tool_result' && tr.content).toContain('保存上限で破棄');
    const last = history[3]!.content[0]!;
    expect(last.type).toBe('image'); // 新しい画像は残る
  });

  it('上限以内なら何もしない', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: PNG_DATA }] },
    ];
    expect(evictOldImagesOverLimit(history, 1024 * 1024)).toBe(0);
    expect(history[0]!.content[0]!.type).toBe('image');
  });
});
