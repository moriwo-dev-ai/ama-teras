import { describe, expect, it } from 'vitest';
import { chunkText, streamEcho } from './echo';

describe('chunkText', () => {
  it('指定サイズで分割する', () => {
    expect(chunkText('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
  });

  it('空文字は空配列', () => {
    expect(chunkText('', 3)).toEqual([]);
  });

  it('サロゲートペアを壊さない', () => {
    expect(chunkText('👍👍👍👍', 3)).toEqual(['👍👍👍', '👍']);
  });

  it('サイズ0はエラー', () => {
    expect(() => chunkText('a', 0)).toThrow();
  });
});

describe('streamEcho', () => {
  it('全チャンクを流して onDone を呼ぶ', async () => {
    const deltas: string[] = [];
    let done = false;
    await streamEcho(
      'hello',
      new AbortController().signal,
      { onDelta: (t) => deltas.push(t), onDone: () => (done = true), onCancelled: () => {} },
      0,
    );
    expect(deltas.join('')).toBe('(echo) hello');
    expect(done).toBe(true);
  });

  it('キャンセルで onCancelled が呼ばれ onDone は呼ばれない', async () => {
    const ac = new AbortController();
    const deltas: string[] = [];
    let done = false;
    let cancelled = false;
    const p = streamEcho(
      'hello world hello world',
      ac.signal,
      {
        onDelta: (t) => {
          deltas.push(t);
          ac.abort();
        },
        onDone: () => (done = true),
        onCancelled: () => (cancelled = true),
      },
      0,
    );
    await p;
    expect(cancelled).toBe(true);
    expect(done).toBe(false);
    expect(deltas.length).toBe(1);
  });
});
