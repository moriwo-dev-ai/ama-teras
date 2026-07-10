import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyPath, isDenied } from './scope';

// Windows形式パスは実行OSに関係なく字句的に判定される(実環境Windowsでの挙動の代表テスト)
const WS = 'C:\\work\\proj';

describe('classifyPath', () => {
  it('workspace 直下・配下は workspace', () => {
    expect(classifyPath('C:\\work\\proj', WS)).toBe('workspace');
    expect(classifyPath('C:\\work\\proj\\src\\a.ts', WS)).toBe('workspace');
    expect(classifyPath('C:/work/proj/src/a.ts', WS)).toBe('workspace');
  });

  it('兄弟ディレクトリ・名前が前方一致するだけのパスは system', () => {
    expect(classifyPath('C:\\work\\other\\a.ts', WS)).toBe('system');
    expect(classifyPath('C:\\work\\proj2\\a.ts', WS)).toBe('system');
  });

  it('.. での遡りは解決してから判定される', () => {
    expect(classifyPath('C:\\work\\proj\\src\\..\\..\\..\\Windows\\a.txt', WS)).toBe('system');
    expect(classifyPath('C:\\work\\proj\\src\\..\\a.ts', WS)).toBe('workspace');
  });

  it('UNCパスは system', () => {
    expect(classifyPath('\\\\server\\share\\file.txt', WS)).toBe('system');
  });

  it('大文字小文字非依存(caseInsensitive: true)で workspace と判定される', () => {
    expect(classifyPath('c:\\WORK\\Proj\\A.TS', WS, { caseInsensitive: true })).toBe('workspace');
    expect(classifyPath('c:\\WORK\\Proj\\A.TS', WS, { caseInsensitive: false })).toBe('system');
  });
});

describe('classifyPath(シンボリックリンク)', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'amateras-scope-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('workspace 内のリンクが外を指す場合は system(realpath で迂回を検出)', async () => {
    const ws = join(base, 'ws');
    const outside = join(base, 'outside');
    await mkdir(ws, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'x');
    try {
      await symlink(outside, join(ws, 'link'), 'dir');
    } catch {
      return; // 権限等でシンボリックリンクを作れない環境ではスキップ
    }
    expect(classifyPath(join(ws, 'link', 'secret.txt'), ws)).toBe('system');
  });

  it('存在しないパスは存在する祖先を辿って判定される', async () => {
    const ws = join(base, 'ws');
    await mkdir(ws, { recursive: true });
    expect(classifyPath(join(ws, 'not', 'yet', 'created.txt'), ws)).toBe('workspace');
    expect(classifyPath(join(base, 'nowhere', 'file.txt'), ws)).toBe('system');
  });
});

describe('isDenied', () => {
  const deny = {
    userDataDir: 'C:\\Users\\me\\AppData\\Roaming\\mycodex',
    repoGitDir: 'C:\\dev\\mycodex\\.git',
  };

  it('userData への書き込みは拒否(config.json / secrets.json / plugin-cache)', () => {
    expect(isDenied('C:\\Users\\me\\AppData\\Roaming\\mycodex\\config.json', 'write', deny)).toBeTruthy();
    expect(isDenied('C:\\Users\\me\\AppData\\Roaming\\mycodex\\secrets.json', 'write', deny)).toBeTruthy();
    expect(isDenied('C:\\Users\\me\\AppData\\Roaming\\mycodex\\plugin-cache\\x.mjs', 'write', deny)).toBeTruthy();
  });

  it('secrets.json は読み取りも拒否、config.json の読み取りは許可', () => {
    expect(isDenied('C:\\Users\\me\\AppData\\Roaming\\mycodex\\secrets.json', 'read', deny)).toBeTruthy();
    expect(isDenied('C:\\Users\\me\\AppData\\Roaming\\mycodex\\config.json', 'read', deny)).toBeNull();
  });

  it('Windowsシステム領域への書き込みは拒否(大文字小文字非依存)', () => {
    expect(isDenied('C:\\Windows\\System32\\drivers\\etc\\hosts', 'write', deny)).toBeTruthy();
    expect(isDenied('c:\\WINDOWS\\a.txt', 'write', deny)).toBeTruthy();
    expect(isDenied('C:\\Program Files\\app\\a.exe', 'write', deny)).toBeTruthy();
    expect(isDenied('C:\\Program Files (x86)\\app\\a.exe', 'write', deny)).toBeTruthy();
    // 読み取りは拒否しない(hostsの参照等は承認制の範囲)
    expect(isDenied('C:\\Windows\\System32\\drivers\\etc\\hosts', 'read', deny)).toBeNull();
  });

  it('リポジトリの .git への書き込みは拒否、読み取りは許可', () => {
    expect(isDenied('C:\\dev\\mycodex\\.git\\HEAD', 'write', deny)).toBeTruthy();
    expect(isDenied('C:\\dev\\mycodex\\.git\\HEAD', 'read', deny)).toBeNull();
    // .git の外(リポジトリ本体)は拒否しない
    expect(isDenied('C:\\dev\\mycodex\\src\\main\\index.ts', 'write', deny)).toBeNull();
  });

  it('.. で保護領域へ遡るパスも拒否される', () => {
    expect(isDenied('C:\\Users\\me\\Desktop\\..\\AppData\\Roaming\\mycodex\\secrets.json', 'write', deny)).toBeTruthy();
    expect(isDenied('C:\\temp\\..\\Windows\\a.dll', 'write', deny)).toBeTruthy();
  });

  it('通常のパスは null', () => {
    expect(isDenied('C:\\Users\\me\\Desktop\\hello.txt', 'write', deny)).toBeNull();
    expect(isDenied('C:\\work\\proj\\a.ts', 'write', deny)).toBeNull();
    expect(isDenied('C:\\work\\proj\\a.ts', 'read', deny)).toBeNull();
  });

  it('deny 未指定でも Windows システム領域だけは拒否される', () => {
    expect(isDenied('C:\\Windows\\a.txt', 'write')).toBeTruthy();
    expect(isDenied('C:\\Users\\me\\a.txt', 'write')).toBeNull();
  });
});
