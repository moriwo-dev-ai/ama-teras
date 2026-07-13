import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '../types';
import plugin from './text_stats';
import { promises as fs } from 'fs';
import * as path from 'path';

function createTestContext(tmpDir: string): ToolContext {
  // Minimal ToolContext implementation for tests
  return {
    cwd: tmpDir,
    signal: new AbortController().signal,
    log: () => {},
  };
}

interface ParsedStats {
  chars: number;
  lines: number;
  words: number;
  bytes: number;
}

function parseStats(content: string): ParsedStats {
  return JSON.parse(content) as ParsedStats;
}

describe('text_stats plugin', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(process.cwd(), 'tmp-text-stats');
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('computes stats for direct text input (mixed Japanese)', async () => {
    const ctx = createTestContext(tmpDir);
    const input = { text: '春の朝焼け\n茜にほどける東の空' };

    const result = await plugin.execute(input, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(2);
    expect(parsed.words).toBe(2);
    expect(parsed.chars).toBeGreaterThan(0);
    expect(parsed.bytes).toBeGreaterThan(0);
  });

  it('computes stats from file path', async () => {
    const ctx = createTestContext(tmpDir);
    const filePath = 'sample.txt';
    const content = 'hello world\nthis is a test file';
    await fs.writeFile(path.join(tmpDir, filePath), content, 'utf8');

    const result = await plugin.execute({ path: filePath }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(2);
    expect(parsed.words).toBe(7);
    expect(parsed.chars).toBe(content.length);
    expect(parsed.bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('streams a large file (bigger than one chunk) without splitting words at chunk boundaries', async () => {
    const ctx = createTestContext(tmpDir);
    const filePath = 'large.txt';
    // 64KiB(highWaterMark)を確実に超えるサイズを生成。1行 = 'word 日本語テスト '×N
    const line = 'word 日本語テスト streaming boundary '.repeat(50); // 5語相当×50 は連結で境界語が繋がらないよう末尾に空白あり
    const lineCount = 200;
    const content = Array.from({ length: lineCount }, () => line).join('\n');
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(64 * 1024);
    await fs.writeFile(path.join(tmpDir, filePath), content, 'utf8');

    const result = await plugin.execute({ path: filePath }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(lineCount);
    // 1行あたり 4語×50 = 200語(末尾空白のため行連結で語が融合しない)
    expect(parsed.words).toBe(lineCount * 200);
    expect(parsed.chars).toBe(Array.from(content).length);
    expect(parsed.bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('returns zeros for an empty file', async () => {
    const ctx = createTestContext(tmpDir);
    const filePath = 'empty.txt';
    await fs.writeFile(path.join(tmpDir, filePath), '', 'utf8');

    const result = await plugin.execute({ path: filePath }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed).toEqual({ chars: 0, lines: 0, words: 0, bytes: 0 });
  });

  it('handles CRLF line endings (CR is whitespace, not a word char)', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({ text: 'one two\r\nthree\r\n' }, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = parseStats(result.content);
    expect(parsed.lines).toBe(3); // 'one two' / 'three' / ''(末尾改行後)
    expect(parsed.words).toBe(3);
  });

  it('returns error for a missing file', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({ path: 'no-such-file.txt' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to compute text stats');
  });

  it('returns error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx: ToolContext = { cwd: tmpDir, signal: controller.signal, log: () => {} };
    const filePath = 'abort.txt';
    await fs.writeFile(path.join(tmpDir, filePath), 'data', 'utf8');

    const result = await plugin.execute({ path: filePath }, ctx);
    expect(result.isError).toBe(true);
  });

  it('returns error for invalid input', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({ text: 123 } as unknown, ctx);
    expect(result.isError).toBe(true);
  });

  it('returns error when neither text nor path is provided', async () => {
    const ctx = createTestContext(tmpDir);
    const result = await plugin.execute({}, ctx);
    expect(result.isError).toBe(true);
  });
});
