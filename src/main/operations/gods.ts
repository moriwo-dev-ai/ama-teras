import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * M33-5(T5): 神の宣言的定義。神は「コード」ではなく「定義データ」
 * (userData/operations/gods/<id>.json)であり、新設・改造は定義の変更に還元される。
 *
 * 【鉄則】定義の変更・新設は人間承認必須(組織図の自己改変こそ最も厳格にゲートする)。
 * 適用経路は岩戸ゲートに登録された 'god-definition' アダプタの executor のみ
 * (= protocol.ts の封印により承認なし適用はコードレベルで不可能)。
 * GodRegistry.applyApproved は、そのexecutor以外から呼んではならない
 * (manager のソースパターンテストで固定)。
 */

/** 実行エンジン(コード側の型付き実装)。定義はエンジンを選んでパラメータを与える */
export const GOD_ENGINES = [
  'metrics-observer',
  'community-patrol',
  'draft-writer',
  'issue-gatekeeper',
  'kamuhakari',
] as const;
export type GodEngine = (typeof GOD_ENGINES)[number];

export interface GodDefinition {
  id: string;
  name: string;
  engine: GodEngine;
  clock: { intervalMin?: number; dailyTimes?: string[] };
  /** community-patrol の目利きプロンプト上書き(未設定=組み込み既定) */
  judgePrompt?: string;
  dailyTokenBudget: number;
  enabled: boolean;
}

/** 組み込み三神+神議の既定定義 */
export const DEFAULT_GOD_DEFS: GodDefinition[] = [
  { id: 'omoi-kami', name: 'OMOI-kami(観測)', engine: 'metrics-observer', clock: { intervalMin: 360 }, dailyTokenBudget: 0, enabled: true },
  { id: 'uzume-patrol', name: 'AMENO-uzume(巡回)', engine: 'community-patrol', clock: { intervalMin: 60 }, dailyTokenBudget: 30_000, enabled: true },
  { id: 'uzume-drafts', name: 'AMENO-uzume(下書き)', engine: 'draft-writer', clock: { intervalMin: 1440 }, dailyTokenBudget: 20_000, enabled: true },
  { id: 'tedika-rao', name: 'TEDIKA-rao(門番)', engine: 'issue-gatekeeper', clock: { intervalMin: 60 }, dailyTokenBudget: 30_000, enabled: true },
  { id: 'kamuhakari', name: '神議(戦略会議)', engine: 'kamuhakari', clock: { intervalMin: 720, dailyTimes: ['09:00', '21:00'] }, dailyTokenBudget: 60_000, enabled: true },
];

/** スキーマ検証(純関数)。不正な定義は理由の一覧を返す */
export function validateGodDefinition(raw: unknown): { ok: boolean; errors: string[]; def?: GodDefinition } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['オブジェクトではない'] };
  const rec = raw as Record<string, unknown>;
  const id = String(rec['id'] ?? '');
  if (!/^[a-z0-9-]{2,40}$/.test(id)) errors.push('id は英小文字・数字・ハイフン(2〜40字)');
  const name = String(rec['name'] ?? '').trim();
  if (name === '') errors.push('name が空');
  const engine = String(rec['engine'] ?? '');
  if (!GOD_ENGINES.includes(engine as GodEngine)) errors.push(`engine は ${GOD_ENGINES.join('/')} のいずれか`);
  const clock = rec['clock'];
  const clockRec = typeof clock === 'object' && clock !== null ? (clock as Record<string, unknown>) : null;
  const intervalMin = clockRec?.['intervalMin'];
  const dailyTimes = clockRec?.['dailyTimes'];
  if (clockRec === null || (intervalMin === undefined && dailyTimes === undefined)) {
    errors.push('clock に intervalMin か dailyTimes が必要');
  }
  if (intervalMin !== undefined && (typeof intervalMin !== 'number' || !Number.isFinite(intervalMin) || intervalMin <= 0)) {
    errors.push('clock.intervalMin は正の数値');
  }
  if (dailyTimes !== undefined && (!Array.isArray(dailyTimes) || dailyTimes.some((t) => typeof t !== 'string' || !/^\d{2}:\d{2}$/.test(t)))) {
    errors.push("clock.dailyTimes は 'HH:MM' の配列");
  }
  const budget = rec['dailyTokenBudget'];
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) errors.push('dailyTokenBudget は0以上の数値');
  const judgePrompt = rec['judgePrompt'];
  if (judgePrompt !== undefined && typeof judgePrompt !== 'string') errors.push('judgePrompt は文字列');
  if (errors.length > 0) return { ok: false, errors };
  const def: GodDefinition = {
    id,
    name,
    engine: engine as GodEngine,
    clock: {
      ...(typeof intervalMin === 'number' ? { intervalMin } : {}),
      ...(Array.isArray(dailyTimes) ? { dailyTimes: dailyTimes as string[] } : {}),
    },
    dailyTokenBudget: budget as number,
    enabled: rec['enabled'] !== false,
  };
  if (typeof judgePrompt === 'string' && judgePrompt.trim() !== '') def.judgePrompt = judgePrompt;
  return { ok: true, errors: [], def };
}

export class GodRegistry {
  private readonly dir: string;

  constructor(operationsDir: string) {
    this.dir = join(operationsDir, 'gods');
  }

  /** 既定の定義を配置(存在するidは触らない=ユーザー/承認済み変更を保持) */
  ensureDefaults(defs: GodDefinition[] = DEFAULT_GOD_DEFS): void {
    mkdirSync(this.dir, { recursive: true });
    const existing = new Set(this.list().map((d) => d.id));
    for (const def of defs) {
      if (!existing.has(def.id)) this.write(def);
    }
  }

  list(): GodDefinition[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const validated = validateGodDefinition(JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
            return validated.ok ? (validated.def ?? null) : null;
          } catch {
            return null;
          }
        })
        .filter((d): d is GodDefinition => d !== null);
    } catch {
      return [];
    }
  }

  get(id: string): GodDefinition | null {
    return this.list().find((d) => d.id === id) ?? null;
  }

  private write(def: GodDefinition): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${def.id}.json`), JSON.stringify(def, null, 1), 'utf8');
  }

  /**
   * 【承認済み専用】定義の適用。岩戸ゲート('god-definition' アダプタ)の executor
   * 以外から呼んではならない(承認バイパスになる)。検証済みの定義のみ受け付ける。
   */
  applyApproved(raw: unknown): { ok: boolean; detail: string; def?: GodDefinition } {
    const validated = validateGodDefinition(raw);
    if (!validated.ok || validated.def === undefined) {
      return { ok: false, detail: `定義が不正: ${validated.errors.join(' / ')}` };
    }
    const isNew = this.get(validated.def.id) === null;
    this.write(validated.def);
    return { ok: true, detail: `${isNew ? '新設' : '改造'}: ${validated.def.name}(${validated.def.engine})`, def: validated.def };
  }
}
