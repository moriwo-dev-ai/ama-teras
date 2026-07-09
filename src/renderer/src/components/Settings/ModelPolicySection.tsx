import type { AppConfig, ModelBand, ModelPolicy, ProviderId, SecretsStatus } from '../../../../shared/types';
import { DEFAULT_MODELS, KNOWN_MODELS } from '../../../../shared/models';

/**
 * M18: 「モデル自動切替」節。planner(メイン会話)/ worker(実行サブ)/ reviewer(日常レビュー)/
 * escalation(格上げ先)を独立に指定する。既定は無効=従来の単一モデル。各帯のAPIキー未登録は警告表示。
 */

const DEFAULT_POLICY: ModelPolicy = {
  enabled: true,
  planner: { provider: 'anthropic', model: 'claude-fable-5' },
  worker: { provider: 'anthropic', model: 'claude-sonnet-5' },
  reviewer: { provider: 'anthropic', model: 'claude-sonnet-5' },
  escalation: { provider: 'anthropic', model: 'claude-fable-5' },
  maxEscalationsPerTask: 1,
};

const PRESETS: { label: string; policy: Omit<ModelPolicy, 'enabled'> }[] = [
  {
    label: '高品質重視(Fable/Sonnet/Fable)',
    policy: {
      planner: { provider: 'anthropic', model: 'claude-fable-5' },
      worker: { provider: 'anthropic', model: 'claude-sonnet-5' },
      // M26-2: 高品質重視は日常レビューも planner と同格で行う
      reviewer: { provider: 'anthropic', model: 'claude-fable-5' },
      escalation: { provider: 'anthropic', model: 'claude-fable-5' },
      maxEscalationsPerTask: 1,
    },
  },
  {
    label: 'コスパ重視(Sonnet/Haiku/Fable)',
    policy: {
      planner: { provider: 'anthropic', model: 'claude-sonnet-5' },
      worker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      // M26-2: コスパ重視は日常レビューを worker と同じ安価帯へ
      reviewer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      escalation: { provider: 'anthropic', model: 'claude-fable-5' },
      maxEscalationsPerTask: 1,
    },
  },
];

const BAND_LABEL: Record<'planner' | 'worker' | 'reviewer' | 'escalation', string> = {
  planner: 'planner(計画・重要レビュー・最終応答)',
  worker: 'worker(実行サブエージェント)',
  reviewer: 'reviewer(日常レビューの監査役)',
  escalation: 'escalation(詰まったら格上げ)',
};

function BandRow({
  name,
  band,
  keyMissing,
  onChange,
}: {
  name: 'planner' | 'worker' | 'reviewer' | 'escalation';
  band: ModelBand;
  keyMissing: boolean;
  onChange: (next: ModelBand) => void;
}): JSX.Element {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-56 shrink-0 text-zinc-400">{BAND_LABEL[name]}</span>
        <select
          className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1"
          value={band.provider}
          onChange={(e) => {
            const provider = e.target.value === 'openai' ? 'openai' : 'anthropic';
            onChange({ provider, model: '' }); // プロバイダ変更時はモデルを既定へ戻す
          }}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <select
          className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1"
          value={band.model}
          onChange={(e) => onChange({ ...band, model: e.target.value })}
        >
          <option value="">既定({DEFAULT_MODELS[band.provider]})</option>
          {KNOWN_MODELS[band.provider].map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {keyMissing && (
        <p className="pl-56 text-[11px] text-amber-400">
          ⚠ {band.provider} のAPIキーが未登録(この帯は動かない/planner代行になる)
        </p>
      )}
    </div>
  );
}

export function ModelPolicySection({
  config,
  secrets,
  onSave,
}: {
  config: AppConfig;
  secrets: SecretsStatus | null;
  onSave: (next: AppConfig) => void;
}): JSX.Element {
  const policy = config.modelPolicy;
  const enabled = policy?.enabled === true;

  const save = (nextPolicy: ModelPolicy | undefined): void => {
    const next: AppConfig = { ...config };
    if (nextPolicy === undefined) delete next.modelPolicy;
    else next.modelPolicy = nextPolicy;
    onSave(next);
  };

  const keyMissing = (p: ProviderId): boolean => (secrets ? !secrets[p] : false);
  const effective = (band: ModelBand): string => band.model || DEFAULT_MODELS[band.provider];

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            if (e.target.checked) save({ ...(policy ?? DEFAULT_POLICY), enabled: true });
            else if (policy) save({ ...policy, enabled: false });
          }}
        />
        モデル自動切替(役割ごとにモデルを使い分け)
      </label>
      {enabled && policy && (
        <div className="space-y-2 rounded border border-zinc-700 bg-zinc-950/50 p-2">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                onClick={() => save({ enabled: true, ...p.policy })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <BandRow
            name="planner"
            band={policy.planner}
            keyMissing={keyMissing(policy.planner.provider)}
            onChange={(b) => save({ ...policy, planner: b })}
          />
          <BandRow
            name="worker"
            band={policy.worker}
            keyMissing={keyMissing(policy.worker.provider)}
            onChange={(b) => save({ ...policy, worker: b })}
          />
          <BandRow
            name="reviewer"
            band={policy.reviewer ?? policy.planner}
            keyMissing={keyMissing((policy.reviewer ?? policy.planner).provider)}
            onChange={(b) => save({ ...policy, reviewer: b })}
          />
          <BandRow
            name="escalation"
            band={policy.escalation ?? policy.planner}
            keyMissing={keyMissing((policy.escalation ?? policy.planner).provider)}
            onChange={(b) => save({ ...policy, escalation: b })}
          />
          <div className="flex items-center gap-2 text-xs">
            <span className="w-56 shrink-0 text-zinc-400">1タスクあたりの最大格上げ回数</span>
            <select
              className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1"
              value={policy.maxEscalationsPerTask ?? 1}
              onChange={(e) =>
                save({ ...policy, maxEscalationsPerTask: Number(e.target.value) })
              }
            >
              <option value={0}>0(格上げしない)</option>
              <option value={1}>1(既定)</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          {/* 現在の割り当て一覧 */}
          <p className="text-[11px] leading-relaxed text-zinc-500">
            現在: メイン会話 = {policy.planner.provider}/{effective(policy.planner)} ・
            実行サブ = {policy.worker.provider}/{effective(policy.worker)} ・
            日常レビュー = {(policy.reviewer ?? policy.planner).provider}/
            {effective(policy.reviewer ?? policy.planner)} ・
            格上げ先 = {(policy.escalation ?? policy.planner).provider}/
            {effective(policy.escalation ?? policy.planner)}(worker が
            エラー/ターン上限/失敗3連続で自動格上げ)。最終マイルストーン完了時・
            コア領域に触れる変更のレビューは reviewer 指定があっても planner で実施。
            進化ジョブは本体設定のモデルを使う
          </p>
        </div>
      )}
      {!enabled && (
        <p className="text-xs text-zinc-500">
          ONにすると、メイン会話(計画・レビュー)は高性能モデル、実行サブエージェントは
          安価なモデル、詰まった箇所だけ自動で上位モデルに格上げ — と役割別に使い分けてコスパを上げる
        </p>
      )}
    </div>
  );
}
