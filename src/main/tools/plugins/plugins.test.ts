import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import bash from './bash';
import edit_file from './edit_file';
import grep from './grep';
import list_dir from './list_dir';
import read_file from './read_file';
import write_file from './write_file';

let dir: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {}, ...overrides };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-tools-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('read_file', () => {
  it('行番号付きで読める', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree');
    const r = await read_file.execute({ path: 'a.txt' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('1\tone\n2\ttwo\n3\tthree');
  });

  it('offset/limit で部分読み', async () => {
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree');
    const r = await read_file.execute({ path: 'a.txt', offset: 2, limit: 1 }, ctx());
    expect(r.content).toBe('2\ttwo');
  });

  it('存在しないファイルはエラー', async () => {
    const r = await read_file.execute({ path: 'nope.txt' }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe('write_file', () => {
  it('親ディレクトリごと作成して書ける', async () => {
    const r = await write_file.execute({ path: 'sub/dir/x.txt', content: 'hello' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(dir, 'sub/dir/x.txt'), 'utf8')).toBe('hello');
  });

  it('writeAllowlist 外は拒否', async () => {
    const r = await write_file.execute(
      { path: 'outside/x.txt', content: 'x' },
      ctx({ writeAllowlist: ['allowed'] }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('許可外');
  });

  it('writeAllowlist 内は書ける', async () => {
    const r = await write_file.execute(
      { path: 'allowed/x.txt', content: 'x' },
      ctx({ writeAllowlist: ['allowed'] }),
    );
    expect(r.isError).toBeUndefined();
  });

  it('cwd外への相対パス脱出は拒否', async () => {
    const r = await write_file.execute(
      { path: '../escape.txt', content: 'x' },
      ctx({ writeAllowlist: ['allowed'] }),
    );
    expect(r.isError).toBe(true);
  });
});

describe('edit_file', () => {
  it('一意な old_string を置換する', async () => {
    await writeFile(join(dir, 'a.txt'), 'foo bar baz');
    const r = await edit_file.execute({ path: 'a.txt', old_string: 'bar', new_string: 'qux' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('foo qux baz');
  });

  it('複数出現は replace_all なしだとエラー', async () => {
    await writeFile(join(dir, 'a.txt'), 'x x');
    const r = await edit_file.execute({ path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('replace_all で全置換', async () => {
    await writeFile(join(dir, 'a.txt'), 'x x');
    const r = await edit_file.execute(
      { path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('y y');
  });

  it('見つからない old_string はエラー', async () => {
    await writeFile(join(dir, 'a.txt'), 'abc');
    const r = await edit_file.execute({ path: 'a.txt', old_string: 'zzz', new_string: 'y' }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe('list_dir', () => {
  it('ファイルとディレクトリを区別して列挙', async () => {
    await writeFile(join(dir, 'f.txt'), 'abc');
    await mkdir(join(dir, 'sub'));
    const r = await list_dir.execute({}, ctx());
    expect(r.content).toContain('f.txt\t3 bytes');
    expect(r.content).toContain('sub/');
  });
});

describe('grep', () => {
  it('パターン一致行を 相対パス:行番号 形式で返す', async () => {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/a.ts'), 'const x = 1;\nconst target = 2;');
    await writeFile(join(dir, 'b.txt'), 'no match here');
    const r = await grep.execute({ pattern: 'target' }, ctx());
    expect(r.content).toBe('src/a.ts:2: const target = 2;');
  });

  it('include でファイルを絞れる', async () => {
    await writeFile(join(dir, 'a.ts'), 'needle');
    await writeFile(join(dir, 'a.md'), 'needle');
    const r = await grep.execute({ pattern: 'needle', include: '.ts' }, ctx());
    expect(r.content).toBe('a.ts:1: needle');
  });

  it('node_modules は無視される', async () => {
    await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules/pkg/x.js'), 'needle');
    const r = await grep.execute({ pattern: 'needle' }, ctx());
    expect(r.content).toBe('(一致なし)');
  });

  it('不正な正規表現はエラー', async () => {
    const r = await grep.execute({ pattern: '[' }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe('bash', () => {
  it('コマンドを実行して出力を返す', async () => {
    const r = await bash.execute({ command: 'echo hello' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content.trim()).toBe('hello');
  });

  it('非ゼロ終了は isError と exit code を返す', async () => {
    const r = await bash.execute({ command: 'exit 3' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('exit code: 3');
  });

  it('cwd で実行される', async () => {
    await writeFile(join(dir, 'marker.txt'), 'x');
    const r = await bash.execute({ command: 'dir /b || ls' }, ctx());
    expect(r.content).toContain('marker.txt');
  });
});
