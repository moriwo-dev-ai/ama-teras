import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GOD_DEFS, GodRegistry, validateGodDefinition } from './gods';
import { IwatoGate } from './protocol';

/**
 * M33-5: 神の宣言的定義。
 * 【鉄則の固定】定義の新設・改造は人間承認必須 — 適用経路は岩戸ゲートに封印された
 * executor のみで、承認が拒否されたら定義ファイルは書き変わらない。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gods-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('M33-5: 定義の検証', () => {
  it('正常な定義が通る(既定の三神+神議は全て有効)', () => {
    for (const def of DEFAULT_GOD_DEFS) {
      const v = validateGodDefinition(def);
      expect(v.ok, def.id).toBe(true);
    }
  });

  it('不正: 未知engine・時計なし・負の予算・不正id', () => {
    expect(validateGodDefinition({ id: 'x1', name: 'n', engine: 'world-domination', clock: { intervalMin: 60 }, dailyTokenBudget: 0 }).errors.join()).toContain('engine');
    expect(validateGodDefinition({ id: 'x1', name: 'n', engine: 'community-patrol', clock: {}, dailyTokenBudget: 0 }).errors.join()).toContain('clock');
    expect(validateGodDefinition({ id: 'x1', name: 'n', engine: 'community-patrol', clock: { intervalMin: 60 }, dailyTokenBudget: -1 }).errors.join()).toContain('dailyTokenBudget');
    expect(validateGodDefinition({ id: 'ダメ', name: 'n', engine: 'community-patrol', clock: { intervalMin: 60 }, dailyTokenBudget: 0 }).errors.join()).toContain('id');
  });
});

describe('M33-5: 承認ゲート経由の適用(無承認の自動有効化は禁止)', () => {
  function setup(approve: boolean): { gate: IwatoGate; registry: GodRegistry } {
    const registry = new GodRegistry(dir);
    registry.ensureDefaults();
    const gate = new IwatoGate(
      () => Promise.resolve(approve),
      () => {},
    );
    gate.register({
      id: 'god-definition',
      capabilities: { read: true, search: false, draft: false, execute: ['apply'] },
      compliance: 'test',
      executor: async (_a, params) => {
        const r = registry.applyApproved(params['definition']);
        if (!r.ok) throw new Error(r.detail);
        return r.detail;
      },
    });
    return { gate, registry };
  }

  const newGod = {
    id: 'uzume-en',
    name: '英語圏巡回',
    engine: 'community-patrol',
    clock: { intervalMin: 120 },
    dailyTokenBudget: 10_000,
    enabled: true,
  };

  it('承認されたら新神が定義ファイルとして生まれる', async () => {
    const { gate, registry } = setup(true);
    const result = await gate.requestExecute('god-definition', 'apply', 'uzume-en', JSON.stringify(newGod), { definition: newGod });
    expect(result.ok).toBe(true);
    expect(registry.get('uzume-en')?.name).toBe('英語圏巡回');
  });

  it('承認拒否なら定義は一切書き変わらない', async () => {
    const { gate, registry } = setup(false);
    const result = await gate.requestExecute('god-definition', 'apply', 'uzume-en', JSON.stringify(newGod), { definition: newGod });
    expect(result.ok).toBe(false);
    expect(registry.get('uzume-en')).toBeNull();
  });

  it('承認されても不正定義は検証で拒否される', async () => {
    const { gate, registry } = setup(true);
    const bad = { ...newGod, id: 'bad-god', engine: 'self-modify' };
    const result = await gate.requestExecute('god-definition', 'apply', 'bad-god', JSON.stringify(bad), { definition: bad });
    expect(result.ok).toBe(false);
    expect(registry.get('bad-god')).toBeNull();
  });

  it('ensureDefaults は既存定義(承認済み変更)を上書きしない', () => {
    const registry = new GodRegistry(dir);
    registry.ensureDefaults();
    const modified = { ...DEFAULT_GOD_DEFS[1]!, dailyTokenBudget: 99_999 };
    expect(registry.applyApproved(modified).ok).toBe(true);
    registry.ensureDefaults(); // 再実行(アプリ再起動相当)
    expect(registry.get(modified.id)?.dailyTokenBudget).toBe(99_999);
  });
});

describe('M33-5: 承認バイパス経路の禁止(ソースパターン固定)', () => {
  it('manager.ts で applyApproved を呼ぶのは god-definition アダプタの executor 1箇所のみ', () => {
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'manager.ts'),
      'utf8',
    );
    const calls = src.match(/applyApproved\(/g) ?? [];
    expect(calls).toHaveLength(1);
    // その1箇所は gate.register の executor 内にある(直呼びの露出がない)
    const idx = src.indexOf('applyApproved(');
    const before = src.slice(Math.max(0, idx - 800), idx);
    expect(before).toContain("id: 'god-definition'");
    expect(before).toContain('executor');
  });
});
