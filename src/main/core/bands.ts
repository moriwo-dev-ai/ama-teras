import { DEFAULT_MODELS } from '../../shared/models';
import type { ModelBand, ModelPolicy, OperationsConfig, ProviderId } from '../../shared/types';

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

/**
 * M34-7: 運営専用モデル帯の解決(純関数・テスト対象)。
 * 神議はplanner帯(=最上位)で1日2回動くため運営コストの大半を占める — 本体の
 * 作業品質と独立に、運営だけ安いモデルへ切り替えられるようにする。
 * 優先順: operations の明示帯 > ModelPolicyの従来帯(kamuhakari→planner / gods→worker)> null(単一モデル設定で代行)
 */
export function resolveOperationsLLM(
  operations: OperationsConfig | undefined,
  policy: ModelPolicy | null,
  role: 'kamuhakari' | 'gods',
): { provider: ProviderId; model: string } | null {
  const explicit = role === 'kamuhakari' ? operations?.kamuhakariBand : operations?.godsBand;
  if (explicit !== undefined) {
    return {
      provider: explicit.provider,
      model: explicit.model.trim() !== '' ? explicit.model : DEFAULT_MODELS[explicit.provider],
    };
  }
  return resolveBandLLM(policy, role === 'kamuhakari' ? 'planner' : 'worker');
}
