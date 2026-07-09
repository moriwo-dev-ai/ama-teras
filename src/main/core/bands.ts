import { DEFAULT_MODELS } from '../../shared/models';
import type { ModelBand, ModelPolicy, ProviderId } from '../../shared/types';

/**
 * M26-9(T9): モデル帯の解決ロジックを service.ts から機械的に抽出(挙動変更なし)。
 * 帯名と未指定時のフォールバック規則の正本はここ。
 */

/** M18: モデル帯の名前(M26-2: reviewer / M26-3: midEscalation・explorer を追加) */
export type ModelBandName = 'planner' | 'worker' | 'escalation' | 'reviewer' | 'midEscalation' | 'explorer';

/**
 * 帯の実効 provider+model。policy 無効(null)なら null。未指定時のフォールバック:
 * escalation/reviewer→planner、midEscalation→escalation(→planner)、explorer→worker
 */
export function resolveBandLLM(
  policy: ModelPolicy | null,
  band: ModelBandName,
): { provider: ProviderId; model: string } | null {
  if (!policy) return null;
  const b: ModelBand =
    band === 'escalation'
      ? (policy.escalation ?? policy.planner)
      : band === 'reviewer'
        ? (policy.reviewer ?? policy.planner)
        : band === 'midEscalation'
          ? (policy.midEscalation ?? policy.escalation ?? policy.planner)
          : band === 'explorer'
            ? (policy.explorer ?? policy.worker)
            : policy[band];
  return { provider: b.provider, model: b.model.trim() !== '' ? b.model : DEFAULT_MODELS[b.provider] };
}
