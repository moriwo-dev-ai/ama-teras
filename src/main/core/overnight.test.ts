import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOvernightPending, saveOvernightPending } from './overnight';

/** M113-2: 一晩モード途中保存の読み書きを固定する */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'overnight-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('M113-2: overnight-pending の永続化', () => {
  it('保存→読み込みで往復する', () => {
    const p = join(dir, 'overnight-pending.json');
    saveOvernightPending(p, { 'conv-1': { resumeAt: '2026-07-31T00:30:00.000Z' } });
    expect(loadOvernightPending(p)).toEqual({ 'conv-1': { resumeAt: '2026-07-31T00:30:00.000Z' } });
  });

  it('ファイルが無い/壊れている/形が違う → 空(起動を止めない)', () => {
    const p = join(dir, 'x.json');
    expect(loadOvernightPending(p)).toEqual({});
    writeFileSync(p, 'not json');
    expect(loadOvernightPending(p)).toEqual({});
    writeFileSync(p, '[1,2]');
    expect(loadOvernightPending(p)).toEqual({});
    writeFileSync(p, '{"a":{"resumeAt":123},"b":{"resumeAt":"2026-01-01T00:00:00Z"}}');
    expect(loadOvernightPending(p)).toEqual({ b: { resumeAt: '2026-01-01T00:00:00Z' } });
  });

  it('親ディレクトリが無くても保存できる', () => {
    const p = join(dir, 'nested', 'deep', 'pending.json');
    saveOvernightPending(p, { c: { resumeAt: '2026-01-01T00:00:00Z' } });
    expect(loadOvernightPending(p)).toEqual({ c: { resumeAt: '2026-01-01T00:00:00Z' } });
  });
});
