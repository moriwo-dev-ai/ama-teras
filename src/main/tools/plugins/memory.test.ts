import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext, ToolPlugin } from '../types';
import memory, { appendToLearnedSection } from './memory';

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {}, ...overrides };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-memory-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('memory ツール(M13-1)', () => {
  it('記憶が無いときの read は非エラー', async () => {
    const r = await memory.execute({ action: 'read' }, ctx());
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain('記憶はまだ無い');
  });

  it('append は「## 学習メモ」節をタイムスタンプ付きで作り、read で読める', async () => {
    const w = await memory.execute({ action: 'append', content: 'ビルドは npm run build を使う' }, ctx());
    expect(w.isError).not.toBe(true);
    const file = await readFile(join(dir, 'AMATERAS.md'), 'utf8');
    expect(file).toContain('## 学習メモ');
    expect(file).toMatch(/- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] ビルドは npm run build を使う/);
    const r = await memory.execute({ action: 'read' }, ctx());
    expect(r.content).toBe(file);
  });

  it('既存の学習メモ節の末尾(次の見出しの前)に追記される', async () => {
    await writeFile(
      join(dir, 'AMATERAS.md'),
      '# 規約\n- 返答は日本語\n\n## 学習メモ\n- [2026-07-01 00:00] 既存メモ\n\n## その他\n何か\n',
      'utf8',
    );
    await memory.execute({ action: 'append', content: '新しい知見' }, ctx());
    const file = await readFile(join(dir, 'AMATERAS.md'), 'utf8');
    const learnedIdx = file.indexOf('## 学習メモ');
    const otherIdx = file.indexOf('## その他');
    const newIdx = file.indexOf('新しい知見');
    expect(newIdx).toBeGreaterThan(learnedIdx);
    expect(newIdx).toBeLessThan(otherIdx); // 節の中に入る(次の見出しの前)
    expect(file).toContain('既存メモ'); // 既存内容は保持
  });

  it('append の複数行は1行に潰される(学習メモは1件=1行)', () => {
    const out = appendToLearnedSection('', '行1\n行2\r\n行3');
    expect(out).toMatch(/- \[.+\] 行1 行2 行3/);
  });

  it('rewrite で全置換できる', async () => {
    await memory.execute({ action: 'append', content: '古い' }, ctx());
    await memory.execute({ action: 'rewrite', content: '# 整理済みの記憶\n' }, ctx());
    const r = await memory.execute({ action: 'read' }, ctx());
    expect(r.content).toBe('# 整理済みの記憶\n');
  });

  it('進化ジョブ(writeAllowlist)では append/rewrite を拒否(read は可)', async () => {
    const evolutionCtx = ctx({ writeAllowlist: ['src/main/tools/plugins'] });
    for (const action of ['append', 'rewrite'] as const) {
      const r = await memory.execute({ action, content: 'x' }, evolutionCtx);
      expect(r.isError).toBe(true);
      expect(r.content).toContain('進化ジョブ');
    }
    const read = await memory.execute({ action: 'read' }, evolutionCtx);
    expect(read.isError).not.toBe(true);
  });

  it('content 無し・不正 action・サイズ超過はエラー', async () => {
    expect((await memory.execute({ action: 'append' }, ctx())).isError).toBe(true);
    expect((await memory.execute({ action: 'delete' }, ctx())).isError).toBe(true);
    const over = await memory.execute({ action: 'append', content: 'あ'.repeat(4 * 1024) }, ctx());
    expect(over.isError).toBe(true);
  });

  it('path 入力は存在しない(固定ファイルのみ)', () => {
    const asPlugin: ToolPlugin = memory;
    expect(asPlugin.inputSchema.properties['path']).toBeUndefined();
    expect(asPlugin.pathParams).toBeUndefined();
  });

  it('M17-1 後方互換: 旧名 MYCODEX.md を読め、append で内容ごと新名へ移行される', async () => {
    await writeFile(join(dir, 'MYCODEX.md'), '# 規約\n- 返答は日本語\n', 'utf8');
    const r = await memory.execute({ action: 'read' }, ctx());
    expect(r.content).toContain('返答は日本語');

    await memory.execute({ action: 'append', content: '新しい知見' }, ctx());
    const file = await readFile(join(dir, 'AMATERAS.md'), 'utf8');
    expect(file).toContain('返答は日本語'); // 旧内容を引き継ぐ
    expect(file).toContain('新しい知見');
    expect(existsSync(join(dir, 'MYCODEX.md'))).toBe(false); // renameで移行
  });
});

describe('memory scope:"user"(M25: ユーザー方針)', () => {
  let userDir: string;
  beforeEach(async () => {
    userDir = await mkdtemp(join(tmpdir(), 'mycodex-usermem-'));
  });
  afterEach(async () => {
    await rm(userDir, { recursive: true, force: true }).catch(() => {});
  });
  const userCtx = (): ToolContext => ctx({ userMemoryDir: userDir });

  it('append は AMATERAS-USER.md(userData)に書き、AMATERAS.md(workspace)には触れない', async () => {
    const w = await memory.execute(
      { action: 'append', content: '成果物は必ずツールで動作確認してから完了とする', scope: 'user' },
      userCtx(),
    );
    expect(w.isError).not.toBe(true);
    expect(w.content).toContain('AMATERAS-USER.md');
    const file = await readFile(join(userDir, 'AMATERAS-USER.md'), 'utf8');
    expect(file).toContain('動作確認してから完了');
    expect(existsSync(join(dir, 'AMATERAS.md'))).toBe(false);
  });

  it('read は scope で読み分ける', async () => {
    await writeFile(join(dir, 'AMATERAS.md'), '- プロジェクト側', 'utf8');
    await writeFile(join(userDir, 'AMATERAS-USER.md'), '- ユーザー側', 'utf8');
    const p = await memory.execute({ action: 'read' }, userCtx());
    const u = await memory.execute({ action: 'read', scope: 'user' }, userCtx());
    expect(p.content).toContain('プロジェクト側');
    expect(u.content).toContain('ユーザー側');
  });

  it('rewrite scope:"user" は全置換される', async () => {
    await writeFile(join(userDir, 'AMATERAS-USER.md'), '- 古い方針', 'utf8');
    await memory.execute({ action: 'rewrite', content: '- 新しい方針', scope: 'user' }, userCtx());
    expect(await readFile(join(userDir, 'AMATERAS-USER.md'), 'utf8')).toBe('- 新しい方針');
  });

  it('userMemoryDir 未注入(進化ジョブ等)では scope:"user" はエラー', async () => {
    const r = await memory.execute({ action: 'read', scope: 'user' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('userMemoryDir');
  });

  it('不正な scope はエラー', async () => {
    const r = await memory.execute({ action: 'read', scope: 'global' }, userCtx());
    expect(r.isError).toBe(true);
  });
});
