import { describe, expect, it } from 'vitest';
import { isRemoteSettable, pickRemoteSettings, REMOTE_SETTABLE_KEYS } from './remoteSettings';

/**
 * M53: 書き込みは許可リスト、**読み取りは拒否リスト**という非対称が実害を生んでいた。
 * `GET /api/settings` が月読の設定一式・workspace の絶対パス・postEditHook を返していた。
 */
describe('M53: リモートへ出す設定は許可リストで決める', () => {
  const config = {
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    maxTurns: 40,
    autoApprove: { safe: true },
    // 以下はリモートへ出してはいけない
    remote: { enabled: true, tokenHash: 'ひみつ' },
    tsukuyomi: { enabled: true, camera: true, micDeviceId: '65d5822d', wakeWords: ['アマテラス'] },
    workspace: 'C:\\dev\\mycodex',
    postEditHook: 'npm run lint',
    operations: { repos: ['moriwo-dev-ai/ama-teras'], zennRepoDir: 'C:\\dev\\zenn-content' },
    scopeMode: 'fullPc',
  };

  it('月読・workspace・postEditHook・operations・remote は出さない', () => {
    const out = pickRemoteSettings(config);

    expect(out['tsukuyomi']).toBeUndefined();
    expect(out['workspace']).toBeUndefined();
    expect(out['postEditHook']).toBeUndefined();
    expect(out['operations']).toBeUndefined();
    expect(out['remote']).toBeUndefined();
    expect(out['scopeMode']).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('ひみつ');
    expect(JSON.stringify(out)).not.toContain('micDeviceId');
  });

  it('スマホの設定画面が必要とするキーは出す', () => {
    const out = pickRemoteSettings(config);

    expect(out).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      maxTurns: 40,
      autoApprove: { safe: true },
    });
  });

  it('未知のキーは既定で漏れない(拒否リストなら漏れていた)', () => {
    const out = pickRemoteSettings({ ...config, 未来に足された設定: '秘密' });

    expect(out['未来に足された設定']).toBeUndefined();
  });

  it('読み取りと書き込みは同じ1つのリストに従う', () => {
    for (const key of REMOTE_SETTABLE_KEYS) expect(isRemoteSettable(key)).toBe(true);
    expect(isRemoteSettable('tsukuyomi')).toBe(false);
    expect(isRemoteSettable('postEditHook')).toBe(false);
  });
});
