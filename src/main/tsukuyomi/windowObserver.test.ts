import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import { GOD_ENGINES } from '../operations/gods';
import { TsukuyomiManager } from './manager';
import { FOREGROUND_PS, parseForeground, windowText } from './windowObserver';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-window-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const make = (over: Record<string, unknown>, hasKey = true, shell = async () => 'Code\tmanager.ts - AMA-teras\n') =>
  new TsukuyomiManager({
    userDataDir: dir,
    getConfig: () => ({ tsukuyomi: { enabled: true, pcObserver: true, ...over } }) as AppConfig,
    hasOwnerKey: () => hasKey,
    emit: () => {},
    shellRunner: shell,
    nowFn: () => new Date('2026-07-12T14:05:00'),
  });

describe('M42-6(TUKU-yomi) PC窓観測: タイトルとプロセス名だけ(スクショは撮らない)', () => {
  it('PowerShellの一行はウィンドウのタイトルとプロセス名しか取らない', () => {
    expect(FOREGROUND_PS).toContain('MainWindowTitle');
    expect(FOREGROUND_PS).toContain('ProcessName');
    // スクリーンショット系のAPIを呼んでいないこと
    expect(FOREGROUND_PS).not.toMatch(/Screenshot|CopyFromScreen|Bitmap/i);
  });

  it('出力のパースと、帳に書く一文(長いタイトルは切る)', () => {
    expect(parseForeground('Code\tmanager.ts - AMA-teras\n')).toEqual({
      process: 'Code',
      title: 'manager.ts - AMA-teras',
    });
    expect(parseForeground('')).toBeNull();
    expect(windowText({ process: 'Code', title: 'manager.ts' }, new Date('2026-07-12T14:05:00'))).toBe(
      '14:05 Code: manager.ts',
    );
    const long = windowText({ process: 'chrome', title: 'あ'.repeat(60) }, new Date('2026-07-12T14:05:00'));
    expect(long.length).toBeLessThan(60);
  });

  it('観測結果は observation(source: pc)として帳へ。同じウィンドウでは二度書かない', async () => {
    const manager = make({});
    expect(await manager.observeWindow()).toBe('14:05 Code: manager.ts - AMA-teras');
    expect(await manager.observeWindow()).toBeNull(); // 同じウィンドウ → 書かない
    const entries = manager.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'observation', source: 'pc' });
  });

  it('pcObserver がOFFなら何もしない(PowerShellも呼ばない)', async () => {
    const shell = vi.fn(async () => 'Code\tx\n');
    const manager = make({ pcObserver: false }, true, shell);
    expect(await manager.observeWindow()).toBeNull();
    expect(shell).not.toHaveBeenCalled();
    expect(manager.pcObserverEnabled()).toBe(false);
  });

  it('鍵の無い機体では観測しない(月読自体が存在しないのと同じ)', async () => {
    const shell = vi.fn(async () => 'Code\tx\n');
    const manager = make({}, false, shell);
    expect(manager.pcObserverEnabled()).toBe(false);
    expect(await manager.observeWindow()).toBeNull();
    expect(shell).not.toHaveBeenCalled();
  });

  it('神のエンジンとして登録されている(神々の時計に載る)', () => {
    expect(GOD_ENGINES).toContain('tsukuyomi-observer');
  });
});
