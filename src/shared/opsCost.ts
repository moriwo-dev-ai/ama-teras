import { MODEL_PRICES } from './models';
import type { GodClockJob, ModelBand } from './types';

/**
 * M41-4: オーナーモードの「想定コスト」概算(表示のみ。既定値は何も変えない)。
 *
 * 一般ユーザーがONにする前に「毎日いくら燃えるのか」を知れるようにする。
 * 実測(usage の kamuhakari/gods 帯)が出るまでの当て推量なので、数字は必ず
 * 「概算」と明示すること。安全側(高め)に見積もる。
 */

/** 神(エンジン)1回の実行で使うトークンの目安。実測(神議 約2.5〜3.1k)より高めに置く */
const TOKENS_PER_RUN: Record<string, number> = {
  kamuhakari: 8000,
  'draft-writer': 6000,
  'community-patrol': 4000,
  'issue-gatekeeper': 5000,
  // 観測はLLMを使わない(APIとHTTPのみ)
  'metrics-observer': 0,
};

/** godId → エンジン(定義が読めないUI側のための既定の対応) */
const ENGINE_BY_GOD: Record<string, string> = {
  kamuhakari: 'kamuhakari',
  'omoi-kami': 'metrics-observer',
  'uzume-drafts': 'draft-writer',
  'uzume-patrol': 'community-patrol',
  'tedika-rao': 'issue-gatekeeper',
};

/** 1日の実行回数(dailyTimes があればその件数、無ければ 1440/間隔) */
export function runsPerDay(job: GodClockJob): number {
  if (!job.enabled) return 0;
  if (job.dailyTimes !== undefined && job.dailyTimes.length > 0) return job.dailyTimes.length;
  return Math.max(1, Math.round(1440 / Math.max(1, job.intervalMin)));
}

/** 1日に使うトークン(予算があればそれで頭打ち。予算0=無制限) */
export function estimateDailyTokens(job: GodClockJob, engine?: string): number {
  const perRun = TOKENS_PER_RUN[engine ?? ENGINE_BY_GOD[job.godId] ?? ''] ?? 5000;
  const raw = perRun * runsPerDay(job);
  return job.dailyTokenBudget > 0 ? Math.min(raw, job.dailyTokenBudget) : raw;
}

/** モデルの単価($/1Mトークン)。未知モデルは null(コスト非表示) */
export function priceOf(band: ModelBand | undefined): { input: number; output: number } | null {
  if (band === undefined) return null;
  const key = `${band.provider}/${band.model}`;
  const price = MODEL_PRICES.find((p) => key.startsWith(p.prefix));
  return price ? { input: price.input, output: price.output } : null;
}

export interface OpsCostEstimate {
  dailyTokens: number;
  /** 単価がわかるときだけ金額を出す(未知モデルは null) */
  dailyUsd: number | null;
  monthlyUsd: number | null;
  /** 内訳(神ごとのトークン) */
  perGod: { godId: string; tokens: number }[];
}

/**
 * 想定コスト。入出力比は 7:3 と仮定(神々は長い入力+短いJSON出力)。
 * kamuhakariBand / godsBand が未設定なら、渡された既定帯(planner/worker)で見積もる
 */
export function estimateOpsCost(
  jobs: GodClockJob[],
  bands: { kamuhakari?: ModelBand; gods?: ModelBand },
): OpsCostEstimate {
  const perGod = jobs.map((j) => ({ godId: j.godId, tokens: estimateDailyTokens(j) }));
  const dailyTokens = perGod.reduce((a, g) => a + g.tokens, 0);

  const kamuPrice = priceOf(bands.kamuhakari);
  const godsPrice = priceOf(bands.gods);
  let dailyUsd: number | null = 0;
  for (const g of perGod) {
    const price = g.godId === 'kamuhakari' ? kamuPrice : godsPrice;
    if (g.tokens === 0) continue;
    if (price === null) {
      dailyUsd = null; // 1つでも単価不明なら金額は出さない(嘘の数字を出さない)
      break;
    }
    dailyUsd += (g.tokens * 0.7 * price.input + g.tokens * 0.3 * price.output) / 1_000_000;
  }
  return {
    dailyTokens,
    dailyUsd,
    monthlyUsd: dailyUsd === null ? null : dailyUsd * 30,
    perGod,
  };
}
