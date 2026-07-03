import { describe, it, expect } from 'vitest';
import plugin from './csv_to_markdown';
import type { ToolContext } from '../types';

function createTestContext(): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('csv_to_markdown plugin', () => {
  it('has correct name', () => {
    expect(plugin.name).toBe('csv_to_markdown');
  });

  it('converts simple CSV to markdown table', async () => {
    const ctx = createTestContext();
    const result = await plugin.execute({ csv: 'a,b\n1,2' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('handles quoted fields and commas', async () => {
    const ctx = createTestContext();
    const result = await plugin.execute({ csv: '"a,1",b\n"1","2"' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('| a,1 | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('returns error on invalid input', async () => {
    const ctx = createTestContext();
    const result = await plugin.execute(null as unknown, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Input must be an object');
  });

  it('returns empty string for empty CSV', async () => {
    const ctx = createTestContext();
    const result = await plugin.execute({ csv: '' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('');
  });
});
