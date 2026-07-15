import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublishedStore } from './published';

/**
 * 改善1: 公開済みツールの控え。守りたいのは「同じツールで2度目のPRを誤って出させない」こと。
 * 控えが読めない/壊れていても、公開そのものは止めない(初回は出せる)
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amateras-pub-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PublishedStore', () => {
  it('記録すると has が真になり、URL/時刻を返す', () => {
    const s = new PublishedStore(join(dir, 'sub', 'published.json'));
    expect(s.has('color_convert')).toBe(false);
    s.record('color_convert', { url: 'https://github.com/x/pull/2', ts: '2026-07-15T00:00:00.000Z' });
    expect(s.has('color_convert')).toBe(true);
    expect(s.get('color_convert')?.url).toBe('https://github.com/x/pull/2');
  });

  it('別インスタンスで開いても残る(アプリを閉じても控えは消えない)', () => {
    const file = join(dir, 'published.json');
    new PublishedStore(file).record('csv_to_json', { url: 'u', ts: 't' });
    expect(new PublishedStore(file).has('csv_to_json')).toBe(true);
  });

  it('list は全件を返す(UIがボタンを止めるのに使う)', () => {
    const s = new PublishedStore(join(dir, 'published.json'));
    s.record('a', { url: 'ua', ts: 't' });
    s.record('b', { url: 'ub', ts: 't' });
    expect(Object.keys(s.list()).sort()).toEqual(['a', 'b']);
  });

  it('壊れたファイルは「まだ何も公開していない」として扱う(公開を止めない)', () => {
    const file = join(dir, 'published.json');
    writeFileSync(file, '{壊れ', 'utf8');
    expect(new PublishedStore(file).has('a')).toBe(false);
  });

  it('forget で控えを外せる(別名で出し直したい時の手当て)', () => {
    const s = new PublishedStore(join(dir, 'published.json'));
    s.record('a', { url: 'ua', ts: 't' });
    s.forget('a');
    expect(s.has('a')).toBe(false);
  });
});
