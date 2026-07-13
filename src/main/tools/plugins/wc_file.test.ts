import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '../types';
import plugin from './wc_file';
import { promises as fs } from 'fs';
import * as path from 'path';

function createTestContext(tmpDir: string): ToolContext {
  return {
    cwd: tmpDir,
    signal: new AbortController().signal,
    log: () => {},
  };
}

interface ParsedStats {
  lines: number;
  words: number;
  chars: number;
}

function parseStats(content: string): ParsedStats {
  return JSON.parse(content) as ParsedStats;
}

describe('wc_file plugin', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(process.cwd(), 'tmp-wc-file');
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('counts lines, words, chars of a simple file', async () => {
    const ctx = createTestContext(tmpDir);
    const content = 'hello world\nthis is a test file\n';
    await fs.writeFile(path.join(tmpDir, 'sample.txt'), content, 'utf8');

    const result = await plugin.execute({ path: 'sample.txt' }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(2);
    expect(parsed.words).toBe(7);
    expect(parsed.chars).toBe(content.length);
  });

  it('counts newline characters like wc -l (no trailing newline)', async () => {
    const ctx = createTestContext(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'no-trailing.txt'), 'one\ntwo', 'utf8');

    const result = await plugin.execute({ path: 'no-trailing.txt' }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(1); // wc -l counts '\n' occurrences
    expect(parsed.words).toBe(2);
  });

  it('handles mixed Japanese text and counts code points', async () => {
    const ctx = createTestContext(tmpDir);
    const content = '春の朝焼け\n茜にほどける東の空\n';
    await fs.writeFile(path.join(tmpDir, 'ja.txt'), content, 'utf8');

    const result = await plugin.execute({ path: 'ja.txt' }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(2);
    expect(parsed.words).toBe(2); // 空白区切りで各行が1語
    expect(parsed.chars).toBe(Array.from(content).length);
  });

  it('counts surrogate-pair characters as one char (code points)', async () => {
    const ctx = createTestContext(tmpDir);
    const content = '𠮷野家 🍣\n'; // 𠮷 と 🍣 はサロゲートペア
    await fs.writeFile(path.join(tmpDir, 'emoji.txt'), content, 'utf8');

    const result = await plugin.execute({ path: 'emoji.txt' }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.chars).toBe(Array.from(content).length);
    expect(parsed.chars).toBeLessThan(content.length); // UTF-16 length より少ない
    expect(parsed.words).toBe(2);
    expect(parsed.lines).toBe(1);
  });

  it('streams a large file (bigger than one 64KiB chunk) without splitting words at chunk boundaries', async () => {
    const ctx = createTestContext(tmpDir);
    // 1行 = 4語 × 50 回(末尾に空白があるため行内で語が融合しない)
    const line = 'word 日本語テスト streaming boundary '.repeat(50);
    const lineCount = 200;
    const content = `${Array.from({ length: lineCount }, () => line).join('\n')}\n`;
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(64 * 1024);
    await fs.writeFile(path.join(tmpDir, 'large.txt'), content, 'utf8');

    const result = await plugin.execute({ path: 'large.txt' }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(lineCount);
    expect(parsed.words).toBe(lineCount * 200);
    expect(parsed.chars).toBe(Array.from(content).length);
  });

  it('returns zeros for an empty file', async () => {
    const ctx = createTestContext(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'empty.txt'), '', 'utf8');

    const result = await plugin.execute({ path: 'empty.txt' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(parseStats(result.content)).toEqual({ lines: 0, words: 0, chars: 0 });
  });

  it('handles CRLF line endings (CR is whitespace, not a word char)', async () => {
    const ctx = createTestContext(tmpDir);
    await fs.writeFile(path.join(tmpDir, 'crlf.txt'), 'one two\r\nthree\r\n', 'utf8');

    const result = await plugin.execute({ path: 'crlf.txt' }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(2);
    expect(parsed.words).toBe(3);
  });

  it('returns error for a missing file', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({ path: 'no-such-file.txt' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to count file');
  });

  it('returns error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx: ToolContext = { cwd: tmpDir, signal: controller.signal, log: () => {} };
    await fs.writeFile(path.join(tmpDir, 'abort.txt'), 'data', 'utf8');

    const result = await plugin.execute({ path: 'abort.txt' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('returns error for invalid input (missing path)', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid input');
  });

  it('returns error for invalid input (non-string path)', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({ path: 123 } as unknown, ctx);
    expect(result.isError).toBe(true);
  });

  it('returns error for empty-string path', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({ path: '' }, ctx);
    expect(result.isError).toBe(true);
  });
});
