import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { toSlug } from './slugify';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

async function slugOf(input: unknown): Promise<string> {
  const r = await plugin.execute(input, ctx());
  expect(r.isError).toBeUndefined();
  const parsed = JSON.parse(r.content) as { slug: string };
  return parsed.slug;
}

describe('slugify plugin', () => {
  it('name がファイル名と一致し risk が safe', () => {
    expect(plugin.name).toBe('slugify');
    expect(plugin.risk).toBe('safe');
    expect(plugin.tags).toContain('テキスト処理');
  });

  it('基本例: "Hello, World! 2026" → "hello-world-2026"', async () => {
    await expect(slugOf({ text: 'Hello, World! 2026' })).resolves.toBe('hello-world-2026');
  });

  it('小文字化される', async () => {
    await expect(slugOf({ text: 'ABCdef' })).resolves.toBe('abcdef');
  });

  it('英数字以外はハイフンに置換され、連続ハイフンは1つに圧縮される', async () => {
    await expect(slugOf({ text: 'foo   bar___baz!!!qux' })).resolves.toBe('foo-bar-baz-qux');
    await expect(slugOf({ text: 'a--b---c' })).resolves.toBe('a-b-c');
  });

  it('前後のハイフン(記号・空白由来)は除去される', async () => {
    await expect(slugOf({ text: '  --Hello--  ' })).resolves.toBe('hello');
    await expect(slugOf({ text: '!leading and trailing?' })).resolves.toBe('leading-and-trailing');
  });

  it('アクセント付きラテン文字は基底文字に変換される', async () => {
    await expect(slugOf({ text: 'Crème Brûlée à la mode' })).resolves.toBe('creme-brulee-a-la-mode');
  });

  it('英数字を含まない文字列(日本語のみ・記号のみ)は空スラッグになる', async () => {
    await expect(slugOf({ text: 'こんにちは世界' })).resolves.toBe('');
    await expect(slugOf({ text: '!!!' })).resolves.toBe('');
    await expect(slugOf({ text: '' })).resolves.toBe('');
  });

  it('日本語と英数字が混在する場合は英数字部分が残る', async () => {
    await expect(slugOf({ text: '第1回 Meetup 2026 東京' })).resolves.toBe('1-meetup-2026');
  });

  it('toSlug 関数を直接呼んでも同じ結果になる', () => {
    expect(toSlug('Hello, World! 2026')).toBe('hello-world-2026');
    expect(toSlug('---')).toBe('');
  });

  it('text が文字列でない・欠落・非オブジェクト入力はエラーを返す', async () => {
    for (const bad of [{ text: 123 }, {}, null, 'raw string', 42]) {
      const r = await plugin.execute(bad, ctx());
      expect(r.isError).toBe(true);
    }
  });

  it('長すぎる text はエラーを返す', async () => {
    const r = await plugin.execute({ text: 'a'.repeat(100_001) }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('長すぎる');
  });
});
