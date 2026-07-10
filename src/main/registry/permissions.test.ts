import { describe, expect, it } from 'vitest';
import { checkPermissions, extractPermissions } from './permissions';

describe('M27-4: extractPermissions(静的解析)', () => {
  it('child_process の import / require を検出する', () => {
    expect(extractPermissions(`import { spawn } from 'node:child_process';`).childProcess).toBe(true);
    expect(extractPermissions(`const cp = require('child_process');`).childProcess).toBe(true);
    expect(extractPermissions(`// child_process という単語だけ`).childProcess).toBe(false);
  });

  it('ネットワーク系モジュールとグローバル fetch を検出する', () => {
    expect(extractPermissions(`import { request } from 'node:https';`).network).toBe(true);
    expect(extractPermissions(`import net from 'net';`).network).toBe(true);
    expect(extractPermissions(`const res = await fetch(url);`).network).toBe(true);
    expect(extractPermissions(`const ws = new WebSocket('wss://x');`).network).toBe(true);
    // URL文字列やプロパティアクセスでは誤検出しない
    expect(extractPermissions(`const url = 'https://example.com'; obj.fetch(1);`).network).toBe(false);
  });

  it('fs 使用で fsScope=workspace、未使用で none', () => {
    expect(extractPermissions(`import { readFile } from 'node:fs/promises';`).fsScope).toBe('workspace');
    expect(extractPermissions(`import { existsSync } from 'fs';`).fsScope).toBe('workspace');
    expect(extractPermissions(`export default {};`).fsScope).toBe('none');
  });

  it('動的 import() も検出する', () => {
    expect(extractPermissions(`const m = await import('node:child_process');`).childProcess).toBe(true);
  });
});

describe('M27-4: checkPermissions(宣言との突き合わせ)', () => {
  const none = { network: false, childProcess: false, fsScope: 'none' } as const;

  it('宣言外のAPI使用は errors(自動リジェクト対象)', () => {
    const r = checkPermissions(none, { network: true, childProcess: true, fsScope: 'workspace' });
    expect(r.errors).toHaveLength(3);
    expect(r.errors.some((e) => e.includes('ネットワーク'))).toBe(true);
    expect(r.errors.some((e) => e.includes('child_process'))).toBe(true);
    expect(r.errors.some((e) => e.includes('ファイル'))).toBe(true);
  });

  it('過剰宣言は warnings(リジェクトしない)', () => {
    const r = checkPermissions({ network: true, childProcess: true, fsScope: 'workspace' }, none);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(3);
  });

  it('宣言と実装が一致すれば errors / warnings とも空', () => {
    const perms = { network: true, childProcess: false, fsScope: 'workspace' } as const;
    const r = checkPermissions(perms, perms);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });
});
