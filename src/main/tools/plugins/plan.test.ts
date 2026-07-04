import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext, ToolPlugin } from '../types';
import plan from './plan';

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {}, ...overrides };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-plan-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('plan ツール(M12-2)', () => {
  it('計画が無いときの read は非エラーで案内を返す', async () => {
    const r = await plan.execute({ action: 'read' }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain('計画はまだ無い');
  });

  it('write → read で往復し、書き込み先は workspace 直下の MYCODEX_PLAN.md に固定', async () => {
    const content = '# 計画\n- [ ] 手順1\n- [x] 手順0\n';
    const w = await plan.execute({ action: 'write', content }, ctx());
    expect(w.isError).not.toBe(true);
    expect(await readFile(join(dir, 'MYCODEX_PLAN.md'), 'utf8')).toBe(content);
    const r = await plan.execute({ action: 'read' }, ctx());
    expect(r.content).toBe(content);
  });

  it('path 入力は存在しない(スキーマに無い)ため任意パスへ書けない', async () => {
    // input に path を紛れ込ませても無視され、固定ファイルにだけ書く
    await plan.execute(
      { action: 'write', content: 'x', path: join(dir, '..', 'evil.md') },
      ctx(),
    );
    expect(await readFile(join(dir, 'MYCODEX_PLAN.md'), 'utf8')).toBe('x');
    const asPlugin: ToolPlugin = plan;
    expect(asPlugin.inputSchema.properties['path']).toBeUndefined();
    expect(asPlugin.pathParams).toBeUndefined();
  });

  it('content 無しの write はエラー', async () => {
    const r = await plan.execute({ action: 'write' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('進化ジョブ(writeAllowlist コンテキスト)では write を拒否する(read は可)', async () => {
    const w = await plan.execute(
      { action: 'write', content: 'x' },
      ctx({ writeAllowlist: ['src/main/tools/plugins'] }),
    );
    expect(w.isError).toBe(true);
    expect(w.content).toContain('進化ジョブ');
    const r = await plan.execute({ action: 'read' }, ctx({ writeAllowlist: ['src/main/tools/plugins'] }));
    expect(r.isError).not.toBe(true);
  });

  it('64KB 超の計画は拒否する', async () => {
    const r = await plan.execute({ action: 'write', content: 'あ'.repeat(64 * 1024) }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('大きすぎる');
  });

  it('不正な action はエラー', async () => {
    const r = await plan.execute({ action: 'delete' }, ctx());
    expect(r.isError).toBe(true);
  });
});
