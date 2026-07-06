import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import {
  composePlanSection,
  composeSystemPrompt,
  planPath,
  readProjectMemory,
  readProjectPlan,
  writeProjectMemory,
} from './memory';

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
    expect(composed).toContain('AMATERAS.md');
  });

  it('記憶が空なら base をそのまま返す', () => {
    expect(composeSystemPrompt('base', '')).toBe('base');
    expect(composeSystemPrompt('base', '   \n  ')).toBe('base');
  });

  it('M17-1 後方互換: 旧名 MYCODEX.md だけがあれば読める', () => {
    writeFileSync(join(dir, 'MYCODEX.md'), '- 旧記憶', 'utf8');
    expect(readProjectMemory(dir)).toBe('- 旧記憶');
  });

  it('M17-1 移行: 旧名だけの状態で書き込むと新名 AMATERAS.md へ移行される', () => {
    writeFileSync(join(dir, 'MYCODEX.md'), '- 旧記憶', 'utf8');
    writeProjectMemory(dir, '- 新記憶');
    expect(existsSync(join(dir, 'AMATERAS.md'))).toBe(true);
    expect(existsSync(join(dir, 'MYCODEX.md'))).toBe(false); // renameで移行
    expect(readProjectMemory(dir)).toBe('- 新記憶');
  });

  it('M17-1: 新旧両方あるときは新名を優先して読む', () => {
    writeFileSync(join(dir, 'MYCODEX.md'), '- 旧', 'utf8');
    writeFileSync(join(dir, 'AMATERAS.md'), '- 新', 'utf8');
    expect(readProjectMemory(dir)).toBe('- 新');
  });
});

describe('project plan(M12-2)', () => {
  it('不在なら空文字、あれば内容を返す', () => {
    expect(readProjectPlan(dir)).toBe('');
    writeFileSync(planPath(dir), '- [ ] 手順1', 'utf8');
    expect(readProjectPlan(dir)).toBe('- [ ] 手順1');
  });

  it('composePlanSection は計画を「## 現在の計画」として注入する(空なら素通し)', () => {
    const composed = composePlanSection('base', '- [x] 済み\n- [ ] 未了');
    expect(composed).toContain('base');
    expect(composed).toContain('## 現在の計画');
    expect(composed).toContain('AMATERAS_PLAN.md');
    expect(composed).toContain('- [ ] 未了');
    expect(composePlanSection('base', '')).toBe('base');
  });

  it('M17-1 後方互換: 旧名 MYCODEX_PLAN.md だけがあれば読める', () => {
    writeFileSync(join(dir, 'MYCODEX_PLAN.md'), '- [ ] 旧計画', 'utf8');
    expect(readProjectPlan(dir)).toBe('- [ ] 旧計画');
  });
});
