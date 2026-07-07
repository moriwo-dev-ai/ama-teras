// 既知モデルの候補一覧。設定UIのドロップダウンに使う。
// プレースホルダの説明文をそのまま入力してしまう事故を防ぐため、自由入力ではなく
// 候補から選ぶ + 明示的な「カスタム」入力に分ける。
import type { ProviderId } from './types';

export interface ModelChoice {
  id: string;
  label: string;
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  // M11-5: 自律開発向けの既定を Fable 5 へ(長時間の自走・エージェント動作に最適化されたモデル)
  anthropic: 'claude-fable-5',
  // M25-4: gpt-5.1 は旧世代(2026-07時点でOpenAI公式カタログから既に外れている)。
  // 現行フラッグシップの gpt-5.5 を既定に(フォールバック時の実力不足対策)
  openai: 'gpt-5.5',
};

export const KNOWN_MODELS: Record<ProviderId, ModelChoice[]> = {
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5(既定)' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  // M25-4: 2026-07時点の現行ラインナップへ更新。旧 gpt-5/gpt-4.1/gpt-4o はOpenAI側で
  // 既にカタログ落ちしているため候補から除外(gpt-5.1のみ移行期間の互換で残す)
  openai: [
    { id: 'gpt-5.5', label: 'GPT-5.5(既定・最上位)' },
    { id: 'gpt-5.4', label: 'GPT-5.4(廉価版フラッグシップ)' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex(エージェント型コーディング特化)' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini(軽量・サブエージェント向け)' },
    { id: 'gpt-5.1', label: 'GPT-5.1(旧世代・非推奨)' },
  ],
};

/** モデルIDが既知候補に含まれるか(含まれなければ「カスタム」扱い) */
export function isKnownModel(provider: ProviderId, model: string): boolean {
  return KNOWN_MODELS[provider].some((m) => m.id === model);
}

/**
 * M13-1: モデルのコンテキスト上限(トークン)。compaction の実測トリガーに使う。
 * 実上限が不明・変動しうるため保守的な値。未知モデルは DEFAULT_CONTEXT_LIMIT。
 * 前方一致で引く(バージョンサフィックス付きIDにも効かせる)。
 */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

// M25-4: gpt-5.4系はmini/nanoの方がprefixが長い(gpt-5.4-mini は 'gpt-5.4' で始まる)ため、
// 先頭一致は必ず具体的なIDを先に置く。最後の 'gpt-5' は gpt-5 / gpt-5.1 等の旧世代の受け皿
const CONTEXT_LIMITS: [prefix: string, limit: number][] = [
  ['claude-', 200_000],
  ['gpt-5.5', 1_050_000],
  ['gpt-5.4-mini', 400_000],
  ['gpt-5.4-nano', 400_000],
  ['gpt-5.4', 1_050_000],
  ['gpt-5.3-codex', 400_000],
  ['gpt-5', 200_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
];

export function contextLimitFor(model: string): number {
  for (const [prefix, limit] of CONTEXT_LIMITS) {
    if (model.startsWith(prefix)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}
