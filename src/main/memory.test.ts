import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeSystemPrompt, readProjectMemory, writeProjectMemory } from './memory';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-mem-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('project memory(M8-2)', () => {
  it('不在なら空文字を返す', () => {
    expect(readProjectMemory(dir)).toBe('');
  });

  it('write→read で往復する', () => {
    writeProjectMemory(dir, '# 規約\n- 返答は箇条書き');
    expect(readProjectMemory(dir)).toContain('返答は箇条書き');
  });

  it('composeSystemPrompt は記憶を system へ注入する', () => {
    const base = 'あなたはMyCodex';
    const composed = composeSystemPrompt(base, '- 返答は必ず箇条書き');
    expect(composed).toContain(base);
    expect(composed).toContain('返答は必ず箇条書き');
    expect(composed).toContain('MYCODEX.md');
  });

  it('記憶が空なら base をそのまま返す', () => {
    expect(composeSystemPrompt('base', '')).toBe('base');
    expect(composeSystemPrompt('base', '   \n  ')).toBe('base');
  });
});
