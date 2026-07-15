import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandOnPath, detectReadiness, envDefined } from './setup';
import { catalogEntry } from './catalog';

/**
 * M93: 前提の実測。PATH 上の実行ファイル検出を一時ディレクトリで確かめる。
 */

describe('commandOnPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amateras-path-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('PATH 上に拡張子付き実行ファイルがあれば見つける', () => {
    const isWin = process.platform === 'win32';
    const file = isWin ? 'mytool.cmd' : 'mytool';
    writeFileSync(join(dir, file), '');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv;
    expect(commandOnPath('mytool', env)).toBe(true);
    expect(commandOnPath('nope', env)).toBe(false);
  });

  it('PATH が空なら false', () => {
    expect(commandOnPath('anything', { PATH: '' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('複数ディレクトリを走査する', () => {
    writeFileSync(join(dir, process.platform === 'win32' ? 'x.exe' : 'x'), '');
    const env = { PATH: ['/no/such', dir].join(delimiter), PATHEXT: '.EXE' } as NodeJS.ProcessEnv;
    expect(commandOnPath('x', env)).toBe(true);
  });
});

describe('envDefined', () => {
  it('空でない値なら true、未定義/空白は false', () => {
    const env = { A: 'v', B: '   ', C: '' } as NodeJS.ProcessEnv;
    expect(envDefined('A', env)).toBe(true);
    expect(envDefined('B', env)).toBe(false);
    expect(envDefined('C', env)).toBe(false);
    expect(envDefined('D', env)).toBe(false);
  });
});

describe('detectReadiness(deps 差し替え)', () => {
  it('注入した hasCommand/hasEnv で判定する', () => {
    const fs = catalogEntry('filesystem')!;
    const r = detectReadiness(fs, { hasCommand: () => true, hasEnv: () => true });
    expect(r.ready).toBe(true);
    const bad = detectReadiness(fs, { hasCommand: () => false, hasEnv: () => true });
    expect(bad.ready).toBe(false);
  });
});
