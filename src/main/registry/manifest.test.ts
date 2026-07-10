import { describe, expect, it } from 'vitest';
import { validateManifest } from './manifest';

const VALID = {
  name: 'csv_to_markdown',
  version: '1.0.0',
  pluginApiVersion: '^1',
  description: 'CSVをMarkdown表に変換する',
  author: 'yuta',
  license: 'AGPL-3.0',
  permissions: { network: false, childProcess: false, fsScope: 'none' },
  dependencies: [],
};

describe('M27-4: validateManifest', () => {
  it('正しい manifest は型付きで返る(smoke省略可)', () => {
    const r = validateManifest(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe('csv_to_markdown');
      expect(r.manifest.smoke).toBeUndefined();
    }
  });

  it('smoke.input が保持される', () => {
    const r = validateManifest({ ...VALID, smoke: { input: { csv: 'a,b' } } });
    expect(r.ok && r.manifest.smoke?.input).toEqual({ csv: 'a,b' });
  });

  it('name のツール名規則違反・不正semver・不正API範囲を全件まとめて報告する', () => {
    const r = validateManifest({
      ...VALID,
      name: 'bad name!',
      version: 'v1',
      pluginApiVersion: '>=1 <2',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('name'))).toBe(true);
      expect(r.errors.some((e) => e.includes('semver'))).toBe(true);
      expect(r.errors.some((e) => e.includes('pluginApiVersion'))).toBe(true);
    }
  });

  it('AGPL非互換ライセンスは拒否される', () => {
    const r = validateManifest({ ...VALID, license: 'SSPL-1.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('license'))).toBe(true);
  });

  it('外部依存があると拒否される(フェーズ1ルール)', () => {
    const r = validateManifest({ ...VALID, dependencies: ['lodash'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('依存ゼロ'))).toBe(true);
  });

  it('permissions の形が崩れていると拒否される', () => {
    const r = validateManifest({ ...VALID, permissions: { network: 'yes' } });
    expect(r.ok).toBe(false);
  });

  it('オブジェクトでない入力は拒否される', () => {
    expect(validateManifest('{}').ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
  });
});
