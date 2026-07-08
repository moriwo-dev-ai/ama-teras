import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_QUEUE_FILENAME, readAndClearPendingQueue, writePendingQueue } from './pendingQueue';

/**
 * M25-7: 進化キューの再起動またぎ永続化(直列キューで未着手だった依頼が
 * renderer/core昇格の再起動で強制終了され、跡形もなく消えるのを防ぐための保存/読み戻し)。
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-pending-queue-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('pendingQueue(M25-7)', () => {
  it('0件のときは何も書かない(ファイル自体を作らない)', () => {
    writePendingQueue(dir, []);
    expect(existsSync(join(dir, PENDING_QUEUE_FILENAME))).toBe(false);
    expect(readAndClearPendingQueue(dir)).toEqual([]);
  });

  it('書いて読み戻せる。読んだら消費済みとしてファイルは削除される', () => {
    const requests = [
      { description: 'A', expectedIO: '-', scope: 'tool' as const },
      { description: 'B', expectedIO: '-2', scope: 'renderer' as const, originConversationId: 'conv-1' },
    ];
    writePendingQueue(dir, requests);
    expect(existsSync(join(dir, PENDING_QUEUE_FILENAME))).toBe(true);

    const restored = readAndClearPendingQueue(dir);
    expect(restored).toEqual(requests);
    expect(existsSync(join(dir, PENDING_QUEUE_FILENAME))).toBe(false);
    // 2回目は空(消費済み)
    expect(readAndClearPendingQueue(dir)).toEqual([]);
  });

  it('ファイルが無ければ空配列(通常起動を妨げない)', () => {
    expect(readAndClearPendingQueue(dir)).toEqual([]);
  });

  it('壊れたJSONは無視して空配列を返し、ファイルは削除される', async () => {
    await writeFile(join(dir, PENDING_QUEUE_FILENAME), '{broken', 'utf8');
    expect(readAndClearPendingQueue(dir)).toEqual([]);
    expect(existsSync(join(dir, PENDING_QUEUE_FILENAME))).toBe(false);
  });

  it('配列でないJSONや不正な要素は除外する', async () => {
    await writeFile(
      join(dir, PENDING_QUEUE_FILENAME),
      JSON.stringify([{ description: 'ok', expectedIO: '-' }, { description: 123 }, 'not-an-object']),
      'utf8',
    );
    expect(readAndClearPendingQueue(dir)).toEqual([{ description: 'ok', expectedIO: '-' }]);
  });
});
