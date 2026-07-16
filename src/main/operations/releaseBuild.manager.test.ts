import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, IwatoRequestPayload } from '../../shared/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';
import type { ReleaseBuildRunner } from './adapters/releaseBuild';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relbuild-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Over {
  runner?: ReleaseBuildRunner; // 未指定=注入しない(配布版相当)
  approve?: boolean;
  onPrompt?: (req: IwatoRequestPayload) => void;
}

function makeManager(over: Over = {}): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () =>
      ({
        workspace: dir,
        operations: { enabled: true, repos: ['o/r'], zennSlugs: [] },
      }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: (req) => {
      over.onPrompt?.(req);
      return Promise.resolve(over.approve ?? true);
    },
    bandProvider: () => 'キー未設定',
    appVersion: '1.1.0',
    // releaseInfo 用: 最新タグ v1.1.0、下書きリリースなし
    ghRunner: async (args: string[]) => {
      if (args[0] === 'release' && args[1] === 'view') return JSON.stringify({ tagName: 'v1.1.0' });
      if (args[0] === 'release' && args[1] === 'list') return '[]';
      return '';
    },
    ...(over.runner !== undefined ? { releaseBuildRunner: over.runner } : {}),
  });
}

const store = (): DraftStore => new DraftStore(join(dir, 'operations'));

describe('M92-A7: リリース下書きのビルド+添付(requestReleaseBuild)', () => {
  it('runner未注入(配布版相当)は承認を求めず「ビルドできない」で断る', async () => {
    const prompt = vi.fn();
    const manager = makeManager({ onPrompt: prompt }); // runnerなし
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'release-note', title: 'v1.2.0', body: '- 改善' }]);
    const r = await manager.requestReleaseBuild(draft!.id, 'o/r', 'minor');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ビルドできない');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('承認すると runner に version/notesBody/workspace を渡してビルドする(公開はしない)', async () => {
    const runner = vi.fn(async () => ({ ok: true, output: 'built' }));
    const prompts: IwatoRequestPayload[] = [];
    const manager = makeManager({ runner, onPrompt: (r) => prompts.push(r) });
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'release-note', title: 'v1.2.0', body: '- 改善' }]);

    const r = await manager.requestReleaseBuild(draft!.id, 'o/r', 'minor');
    expect(r.ok).toBe(true);
    // 最新 v1.1.0 の minor = 1.2.0
    expect(runner).toHaveBeenCalledWith({
      version: '1.2.0',
      notesBody: '# v1.2.0\n\n- 改善',
      workspace: dir,
    });
    // 承認ダイアログに「公開はしない」こととバージョンが出る
    expect(prompts[0]?.preview).toContain('1.2.0');
    expect(prompts[0]?.preview).toContain('公開');
    expect(prompts[0]?.preview).toContain('しません');
  });

  it('承認しなければ runner は呼ばれない(岩戸ゲートの封印)', async () => {
    const runner = vi.fn(async () => ({ ok: true, output: '' }));
    const manager = makeManager({ runner, approve: false });
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'release-note', title: 'v1.2.0', body: '- x' }]);
    const r = await manager.requestReleaseBuild(draft!.id, 'o/r', 'minor');
    expect(r.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('リリースノート以外の下書き・観測対象外リポジトリは弾く', async () => {
    const runner = vi.fn(async () => ({ ok: true, output: '' }));
    const manager = makeManager({ runner });
    manager.listDrafts();
    const [xpost] = store().add([{ kind: 'x-post', title: 't', body: 'b' }]);
    expect((await manager.requestReleaseBuild(xpost!.id, 'o/r', 'minor')).ok).toBe(false);
    const [note] = store().add([{ kind: 'release-note', title: 'v1.2.0', body: '- x' }]);
    const r = await manager.requestReleaseBuild(note!.id, 'other/repo', 'minor');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('観測対象');
    expect(runner).not.toHaveBeenCalled();
  });

  it('runner が失敗したらゲート経由で失敗が返る(握りつぶさない)', async () => {
    const runner = vi.fn(async () => ({ ok: false, output: 'dist failed: nsis error' }));
    const manager = makeManager({ runner });
    manager.listDrafts();
    const [draft] = store().add([{ kind: 'release-note', title: 'v1.2.0', body: '- x' }]);
    const r = await manager.requestReleaseBuild(draft!.id, 'o/r', 'v2.0.0');
    expect(r.ok).toBe(false);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0' }));
  });
});
