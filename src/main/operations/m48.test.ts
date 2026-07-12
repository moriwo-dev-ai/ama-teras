import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, IwatoRequestPayload } from '../../shared/types';
import { OperationsManager } from './manager';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm48-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** gh のダミー。下書きリリースの添付物を差し替えてテストする */
function makeManager(assets: string[], onPrompt: (req: IwatoRequestPayload) => boolean = () => true) {
  const calls: string[][] = [];
  const manager = new OperationsManager({
    userDataDir: dir,
    getConfig: () => ({ operations: { enabled: true, repos: ['o/r'], zennSlugs: [] } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: (req) => Promise.resolve(onPrompt(req)),
    bandProvider: () => 'キー未設定',
    appVersion: '1.1.0',
    ghRunner: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'release' && args[1] === 'view') {
        return JSON.stringify({ tagName: 'v1.1.0', isDraft: true, name: 'x', assets: assets.map((name) => ({ name })) });
      }
      if (args[0] === 'release' && args[1] === 'list') {
        return JSON.stringify([{ tagName: 'v1.1.0', isDraft: true }]);
      }
      return '';
    },
  });
  return { manager, calls };
}

describe('M48: 下書きリリースの公開(押した瞬間に全利用者へ更新通知が飛ぶ)', () => {
  it('配布物が付いていない下書きは公開させない(更新通知だけ出て落とすものが無い状態を作らない)', async () => {
    const prompt = vi.fn(() => true);
    const { manager, calls } = makeManager([], prompt);
    await manager.status();

    const r = await manager.requestReleasePublish('o/r', 'v1.1.0');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('インストーラが添付されていない');
    expect(prompt).not.toHaveBeenCalled(); // 承認を求めることすらしない
    expect(calls.some((c) => c.includes('--draft=false'))).toBe(false);
  });

  it('添付があれば承認ダイアログへ。全文に「全利用者に更新バナーが出る」と添付物が出る', async () => {
    const prompts: IwatoRequestPayload[] = [];
    const { manager, calls } = makeManager(['AMA-teras Setup 1.1.0.exe'], (req) => {
      prompts.push(req);
      return true;
    });
    await manager.status();

    const r = await manager.requestReleasePublish('o/r', 'v1.1.0');
    expect(r.ok).toBe(true);
    expect(prompts[0]?.preview).toContain('すべての利用者のアプリに更新バナーが出ます');
    expect(prompts[0]?.preview).toContain('AMA-teras Setup 1.1.0.exe');
    expect(calls.some((c) => c.includes('--draft=false'))).toBe(true); // 承認後に公開が走る
  });

  it('承認しなければ公開されない(岩戸ゲートの封印)', async () => {
    const { manager, calls } = makeManager(['AMA-teras Setup 1.1.0.exe'], () => false);
    await manager.status();

    const r = await manager.requestReleasePublish('o/r', 'v1.1.0');
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.includes('--draft=false'))).toBe(false);
  });

  it('観測対象に無いリポジトリへは公開できない(他人のリポジトリを触らない)', async () => {
    const { manager } = makeManager(['AMA-teras Setup 1.1.0.exe']);
    await manager.status();
    const r = await manager.requestReleasePublish('someone/else', 'v1.1.0');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('観測対象リポジトリに無い');
  });

  it('releaseInfo は公開待ちの下書きを返す(UIが公開ボタンを出す条件)', async () => {
    const { manager } = makeManager(['AMA-teras Setup 1.1.0.exe']);
    await manager.status();
    const info = await manager.releaseInfo('o/r');
    expect(info.pendingDraft).toEqual({ tag: 'v1.1.0', assets: ['AMA-teras Setup 1.1.0.exe'] });
  });
});
