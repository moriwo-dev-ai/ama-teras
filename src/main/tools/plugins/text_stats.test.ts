import { describe, it, expect, beforeEach } from 'vitest';
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

describe('text_stats plugin', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(process.cwd(), 'tmp-text-stats');
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
  });

  it('computes stats for direct text input (mixed Japanese)', async () => {
    const ctx = createTestContext(tmpDir);
    const input = { text: '春の朝焼け\n茜にほどける東の空' };

    const result = await plugin.execute(input, ctx);
    expect(result.isError).toBeUndefined();

    const parsed = JSON.parse(result.content) as {
      chars: number;
      lines: number;
      words: number;
      bytes: number;
    };

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

    const parsed = JSON.parse(result.content) as {
      chars: number;
      lines: number;
      words: number;
      bytes: number;
    };

    expect(parsed.lines).toBe(2);
    expect(parsed.words).toBe(7);
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
