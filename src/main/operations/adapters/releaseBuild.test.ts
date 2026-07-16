import { describe, expect, it, vi } from 'vitest';
import { createReleaseBuildAdapter } from './releaseBuild';

describe('release-build アダプタ(M92-A7)', () => {
  it('宣言: execute=[build-draft]、read のみ', () => {
    const a = createReleaseBuildAdapter(async () => ({ ok: true, output: '' }));
    expect(a.id).toBe('release-build');
    expect(a.capabilities.execute).toEqual(['build-draft']);
    expect(a.capabilities.draft).toBe(false);
  });

  it('承認後、version/notesBody/workspace を runner に渡して成功詳細を返す', async () => {
    const run = vi.fn(async () => ({ ok: true, output: 'built ok' }));
    const a = createReleaseBuildAdapter(run);
    const detail = await a.executor!('build-draft', {
      version: '1.2.3',
      notesBody: '# v1.2.3\n\n- x',
      workspace: '/repo',
    });
    expect(run).toHaveBeenCalledWith({ version: '1.2.3', notesBody: '# v1.2.3\n\n- x', workspace: '/repo' });
    expect(detail).toContain('v1.2.3');
    expect(detail).toContain('公開はまだ');
  });

  it('不正なバージョン・未対応アクション・workspace未設定は throw(実行しない)', async () => {
    const run = vi.fn(async () => ({ ok: true, output: '' }));
    const a = createReleaseBuildAdapter(run);
    await expect(a.executor!('publish', {})).rejects.toThrow();
    await expect(a.executor!('build-draft', { version: 'x', workspace: '/r' })).rejects.toThrow('不正なバージョン');
    await expect(a.executor!('build-draft', { version: '1.0.0', workspace: '' })).rejects.toThrow('workspace');
    expect(run).not.toHaveBeenCalled();
  });

  it('runner 失敗は握りつぶさず、ログ末尾つきで throw する', async () => {
    const run = vi.fn(async () => ({ ok: false, output: 'electron-builder: signing failed at step 4' }));
    const a = createReleaseBuildAdapter(run);
    await expect(
      a.executor!('build-draft', { version: '1.0.0', notesBody: 'x', workspace: '/r' }),
    ).rejects.toThrow('signing failed');
  });
});
