import { describe, expect, it } from 'vitest';
import {
  MCP_CATALOG,
  catalogEntry,
  evaluateReadiness,
  fillArgs,
  toServerConfig,
  unresolvedPlaceholders,
} from './catalog';
import { isValidServerName } from './manager';

/**
 * M93: セットアップ助手の純粋ロジック。カタログ整合・テンプレ埋め・前提点検を
 * ライブ接続なしで固める。
 */

describe('MCP_CATALOG(健全性)', () => {
  it('id と suggestedName が正規で重複しない', () => {
    const ids = new Set<string>();
    for (const e of MCP_CATALOG) {
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      // suggestedName は実際にサーバー名として通る綴りであること
      expect(isValidServerName(e.suggestedName)).toBe(true);
      expect(e.command.trim()).not.toBe('');
      expect(e.prereqs.length).toBeGreaterThan(0);
    }
  });

  it('placeholders は args 内に {{token}} として実在する', () => {
    for (const e of MCP_CATALOG) {
      for (const p of e.placeholders ?? []) {
        expect(e.args).toContain(`{{${p.token}}}`);
      }
    }
  });
});

describe('fillArgs / unresolvedPlaceholders', () => {
  it('トークンを値で置換し、未指定は残す', () => {
    const args = ['-y', 'pkg', '{{dir}}', '{{other}}'];
    expect(fillArgs(args, { dir: 'C:\\dev' })).toEqual(['-y', 'pkg', 'C:\\dev', '{{other}}']);
  });

  it('空文字は未指定扱い(置換しない)', () => {
    expect(fillArgs(['{{dir}}'], { dir: '   ' })).toEqual(['{{dir}}']);
  });

  it('未解決トークンを列挙する', () => {
    expect(unresolvedPlaceholders(['-y', '{{dir}}', 'x', '{{k}}'])).toEqual(['dir', 'k']);
    expect(unresolvedPlaceholders(['-y', 'done'])).toEqual([]);
  });
});

describe('toServerConfig', () => {
  it('未信頼で作り、args を埋める', () => {
    const fs = catalogEntry('filesystem')!;
    const sc = toServerConfig(fs, { dir: 'C:\\work' });
    expect(sc.trusted).toBe(false); // 信頼は人間が握る
    expect(sc.enabled).toBe(true);
    expect(sc.command).toBe('npx');
    expect(sc.args).toContain('C:\\work');
    expect(sc.args).not.toContain('{{dir}}');
  });
});

describe('evaluateReadiness', () => {
  const entry = catalogEntry('blender')!; // command(uvx) + manual を持つ

  it('command が揃えば ready、manual は勘定に入れない', () => {
    const r = evaluateReadiness(entry, { hasCommand: () => true, hasEnv: () => true });
    expect(r.ready).toBe(true); // 自動判定分(uvx)がOK
    expect(r.manualCount).toBe(1); // Blender 起動の manual が1件残る
    expect(r.items.some((i) => i.kind === 'manual' && i.ok === null)).toBe(true);
  });

  it('command が無ければ not ready', () => {
    const r = evaluateReadiness(entry, { hasCommand: () => false, hasEnv: () => true });
    expect(r.ready).toBe(false);
    expect(r.items.find((i) => i.kind === 'command')?.ok).toBe(false);
  });

  it('requiredEnv 未設定は manualCount に積まれ ready を崩す', () => {
    const paid = {
      ...entry,
      prereqs: [{ kind: 'command' as const, name: 'uvx', hint: 'uv' }],
      requiredEnv: ['SOME_API_KEY'],
    };
    const r = evaluateReadiness(paid, { hasCommand: () => true, hasEnv: () => false });
    expect(r.ready).toBe(false);
    expect(r.manualCount).toBe(1);
    expect(r.items.find((i) => i.name === 'SOME_API_KEY')?.ok).toBe(false);
  });
});
