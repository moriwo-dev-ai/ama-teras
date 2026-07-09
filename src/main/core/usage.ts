import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageBandRow, UsageDelta, UsageSummary, UsageModelRow } from '../../shared/types';

/**
 * M23-2: 使用量メーター(残高に準ずるもの)。
 * AnthropicにもOpenAIにも「残高を返すAPI」は無い(ダッシュボードのみ)ため、
 * アプリ側で全LLM呼び出しの実測トークンを日別×モデル別に集計し、既知の単価から
 * 概算コストを出す。正確な残高は各プロバイダのダッシュボードで確認する
 */

interface Cell {
  input: number;
  output: number;
  cacheRead: number;
  calls: number;
}

interface UsageFile {
  /** day(YYYY-MM-DD, ローカル) → "provider/model" → 集計 */
  days: Record<string, Record<string, Cell>>;
  /**
   * M26-4: day → band → "provider/model" → 集計。帯別コストの概算はモデル単価が要るため
   * band直下にもモデルキーを保持する。旧ファイルには無い(optional・後方互換)
   */
  bandDays?: Record<string, Record<string, Record<string, Cell>>>;
}

/**
 * 既知モデルの単価($/1Mトークン)。前方一致で照合。未知モデルはコスト非表示。
 * M25-4: gpt-5.4系はmini/nanoの方がprefixが長いため、必ず具体的なIDを先に置く
 * (openai/gpt-5.4-mini は openai/gpt-5.4 で始まるため、後者を先に置くと誤照合する)
 */
const PRICES: { prefix: string; input: number; output: number; cacheReadRatio: number }[] = [
  { prefix: 'anthropic/claude-fable-5', input: 10, output: 50, cacheReadRatio: 0.1 },
  { prefix: 'anthropic/claude-opus', input: 5, output: 25, cacheReadRatio: 0.1 },
  // Sonnet 5 は 2026-08-31 まで導入価格($2/$10)だが、概算は定価で出す(高め=安全側)
  { prefix: 'anthropic/claude-sonnet', input: 3, output: 15, cacheReadRatio: 0.1 },
  { prefix: 'anthropic/claude-haiku', input: 1, output: 5, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.5', input: 5, output: 30, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.4-mini', input: 0.75, output: 4.5, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.4-nano', input: 0.2, output: 1.25, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.4', input: 2.5, output: 15, cacheReadRatio: 0.1 },
  { prefix: 'openai/gpt-5.3-codex', input: 1.75, output: 14, cacheReadRatio: 0.1 },
];

export function estimateCostUsd(key: string, c: { input: number; output: number; cacheRead: number }): number | null {
  const price = PRICES.find((p) => key.startsWith(p.prefix));
  if (!price) return null;
  return (
    (c.input * price.input + c.output * price.output + c.cacheRead * price.input * price.cacheReadRatio) / 1_000_000
  );
}

function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class UsageMeter {
  private data: UsageFile = { days: {} };
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as UsageFile;
      if (raw && typeof raw.days === 'object') this.data = raw;
    } catch {
      /* 初回・壊れているときは空から */
    }
  }

  record(provider: string, model: string, delta: UsageDelta, band?: string): void {
    const day = localDay(this.now());
    const key = `${provider}/${model}`;
    const add = (cell: Cell): void => {
      cell.input += delta.inputTokens;
      cell.output += delta.outputTokens;
      cell.cacheRead += delta.cacheReadTokens;
      cell.calls += 1;
    };
    const byModel = (this.data.days[day] ??= {});
    add((byModel[key] ??= { input: 0, output: 0, cacheRead: 0, calls: 0 }));
    // M26-4: 帯別集計(band無しは 'other' に集約)
    const bandDays = (this.data.bandDays ??= {});
    const byBand = (bandDays[day] ??= {});
    const bandModels = (byBand[band ?? 'other'] ??= {});
    add((bandModels[key] ??= { input: 0, output: 0, cacheRead: 0, calls: 0 }));
    this.scheduleWrite();
  }

  /** 書き込みは1秒デバウンス(呼び出しごとのIO負荷を避ける) */
  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 1000);
    this.writeTimer.unref?.();
  }

  flush(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
    } catch (err) {
      console.error('[usage] 保存失敗:', err instanceof Error ? err.message : err);
    }
  }

  summary(): UsageSummary {
    const today = localDay(this.now());
    const rows = new Map<string, { today: Cell; total: Cell }>();
    const empty = (): Cell => ({ input: 0, output: 0, cacheRead: 0, calls: 0 });
    for (const [day, byModel] of Object.entries(this.data.days)) {
      for (const [key, c] of Object.entries(byModel)) {
        const row = rows.get(key) ?? { today: empty(), total: empty() };
        row.total.input += c.input;
        row.total.output += c.output;
        row.total.cacheRead += c.cacheRead;
        row.total.calls += c.calls;
        if (day === today) {
          row.today.input += c.input;
          row.today.output += c.output;
          row.today.cacheRead += c.cacheRead;
          row.today.calls += c.calls;
        }
        rows.set(key, row);
      }
    }
    const models: UsageModelRow[] = [...rows.entries()]
      .map(([key, r]) => ({
        model: key,
        today: { ...r.today, costUsd: estimateCostUsd(key, r.today) },
        total: { ...r.total, costUsd: estimateCostUsd(key, r.total) },
      }))
      .sort((a, b) => (b.today.input + b.today.output) - (a.today.input + a.today.output));

    // M26-4: 帯別集計。コストはモデルごとに単価照合してから帯へ合算する
    const bandAgg = new Map<string, { today: Cell & { cost: number | null }; total: Cell & { cost: number | null } }>();
    for (const [day, byBand] of Object.entries(this.data.bandDays ?? {})) {
      for (const [band, byModel] of Object.entries(byBand)) {
        const row =
          bandAgg.get(band) ??
          { today: { ...empty(), cost: null }, total: { ...empty(), cost: null } };
        for (const [key, c] of Object.entries(byModel)) {
          const cost = estimateCostUsd(key, c);
          const addTo = (side: Cell & { cost: number | null }): void => {
            side.input += c.input;
            side.output += c.output;
            side.cacheRead += c.cacheRead;
            side.calls += c.calls;
            if (cost !== null) side.cost = (side.cost ?? 0) + cost;
          };
          addTo(row.total);
          if (day === today) addTo(row.today);
        }
        bandAgg.set(band, row);
      }
    }
    const bands: UsageBandRow[] = [...bandAgg.entries()]
      .map(([band, r]) => ({
        band,
        today: { input: r.today.input, output: r.today.output, cacheRead: r.today.cacheRead, calls: r.today.calls, costUsd: r.today.cost },
        total: { input: r.total.input, output: r.total.output, cacheRead: r.total.cacheRead, calls: r.total.calls, costUsd: r.total.cost },
      }))
      .sort((a, b) => (b.total.input + b.total.output) - (a.total.input + a.total.output));
    const sum = (pick: (m: UsageModelRow) => number | null): number | null => {
      let acc = 0;
      let known = false;
      for (const m of models) {
        const v = pick(m);
        if (v !== null) {
          acc += v;
          known = true;
        }
      }
      return known ? acc : null;
    };
    return {
      day: today,
      models,
      bands,
      todayCostUsd: sum((m) => m.today.costUsd),
      totalCostUsd: sum((m) => m.total.costUsd),
    };
  }
}
