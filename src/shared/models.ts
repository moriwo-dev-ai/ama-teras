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
  openai: 'gpt-5.1',
};

export const KNOWN_MODELS: Record<ProviderId, ModelChoice[]> = {
  anthropic: [
    { id: 'claude-fable-5', label: 'Claude Fable 5(既定)' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-5.1', label: 'GPT-5.1(既定)' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
};

/** モデルIDが既知候補に含まれるか(含まれなければ「カスタム」扱い) */
export function isKnownModel(provider: ProviderId, model: string): boolean {
  return KNOWN_MODELS[provider].some((m) => m.id === model);
}
