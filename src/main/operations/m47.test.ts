import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import { bumpVersionText, createRepoVersionAdapter, readPackageVersion, versionFromTag } from './adapters/repoVersion';
import { OperationsManager } from './manager';

let dir: string;
const PKG = '{\n  "name": "amateras",\n  "version": "1.0.0",\n  "scripts": { "build": "vite build" }\n}\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm47-'));
  writeFileSync(join(dir, 'package.json'), PKG, 'utf8');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('M47: リリース時に package.json の version を自動で上げる', () => {
  it('version 行だけを書き換える(整形し直さない=差分が汚れない)', () => {
    const out = bumpVersionText(PKG, '1.1.0');
    expect(out).toContain('"version": "1.1.0"');
    expect(out).toContain('"scripts": { "build": "vite build" }'); // 他の行はそのまま
    expect(bumpVersionText('{}', '1.1.0')).toBeNull();
    expect(versionFromTag('v1.1.0')).toBe('1.1.0');
    expect(readPackageVersion(dir)).toBe('1.0.0');
  });

  it('executor: package.json を書き換え、package.json だけをステージングして push する', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (args: string[]) => {
      calls.push(args);
      return args[0] === 'rev-parse' ? 'main\n' : '';
    });
    const adapter = createRepoVersionAdapter(dir, run);
    const detail = await adapter.executor!('bump', { to: '1.1.0' });

    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('"version": "1.1.0"');
    expect(calls[0]).toEqual(['add', 'package.json']); // git add -A ではない(他の変更を巻き込まない)
    expect(calls[1]).toEqual(['commit', '-m', 'chore: bump version to 1.1.0']);
    expect(calls[3]).toEqual(['push', 'origin', 'main']);
    expect(detail).toContain('1.1.0');
  });

  it('不正なバージョンは実行しない', async () => {
    const adapter = createRepoVersionAdapter(dir, vi.fn());
    await expect(adapter.executor!('bump', { to: 'latest' })).rejects.toThrow('不正なバージョン');
  });

  it('承認しなければ package.json は書き換わらない(岩戸ゲートの封印)', async () => {
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ workspace: dir, operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(false), // 拒否
      bandProvider: () => 'キー未設定',
      gitRunner: async () => '',
      ghRunner: async () => '',
    });
    await manager.status();

    const r = await manager.bumpPackageVersion('v1.1.0');
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('"version": "1.0.0"');
  });

  it('すでに同じ版なら何もしない(承認も求めない)', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({ workspace: dir, operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: prompt,
      bandProvider: () => 'キー未設定',
      gitRunner: async () => '',
      ghRunner: async () => '',
    });
    await manager.status();

    const r = await manager.bumpPackageVersion('v1.0.0');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('すでに');
    expect(prompt).not.toHaveBeenCalled();
  });
});
