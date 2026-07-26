import type { AppConfig, ModelBand, ModelPolicy, ProviderId, SecretsStatus } from '../../../../shared/types';
import { useT, type MessageKey } from '../../i18n';
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

const PRESETS: { labelKey: MessageKey; policy: Omit<ModelPolicy, 'enabled'> }[] = [
  {
    labelKey: 'mpolicy.presetQuality',
    policy: {
      planner: { provider: 'anthropic', model: 'claude-fable-5' },
      worker: { provider: 'anthropic', model: 'claude-sonnet-5' },
      // M26-2: 高品質重視は日常レビューも planner と同格で行う
      reviewer: { provider: 'anthropic', model: 'claude-fable-5' },
      // M26-3: 調査も worker と同格。中間格上げは Opus を挟む
      explorer: { provider: 'anthropic', model: 'claude-sonnet-5' },
      midEscalation: { provider: 'anthropic', model: 'claude-opus-4-8' },
      escalation: { provider: 'anthropic', model: 'claude-fable-5' },
      maxEscalationsPerTask: 1,
    },
  },
  {
    labelKey: 'mpolicy.presetValue',
    policy: {
      planner: { provider: 'anthropic', model: 'claude-sonnet-5' },
      worker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      // M26-2: コスパ重視は日常レビューを worker と同じ安価帯へ
      reviewer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      // M26-3: 調査は Haiku、中間格上げに Opus(いきなり Fable まで上げない)
      explorer: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      midEscalation: { provider: 'anthropic', model: 'claude-opus-4-8' },
      escalation: { provider: 'anthropic', model: 'claude-fable-5' },
      maxEscalationsPerTask: 1,
    },
  },
  {
    // M30-1: GPT-5.6 世代(Sol/Terra/Luna)のOpenAI構成。
    // 指示された4帯(planner/escalation=Sol・worker=Terra・explorer=Luna)のみ指定し、
    // reviewer は planner 代行・midEscalation は escalation フォールバックの既定規則に委ねる
    labelKey: 'mpolicy.presetOpenai',
    policy: {
      planner: { provider: 'openai', model: 'gpt-5.6-sol' },
      worker: { provider: 'openai', model: 'gpt-5.6-terra' },
      explorer: { provider: 'openai', model: 'gpt-5.6-luna' },
      escalation: { provider: 'openai', model: 'gpt-5.6-sol' },
      maxEscalationsPerTask: 1,
    },
  },
];

type BandName = 'planner' | 'worker' | 'explorer' | 'reviewer' | 'midEscalation' | 'escalation';

const BAND_LABEL: Record<BandName, MessageKey> = {
  planner: 'mpolicy.bandPlanner',
  worker: 'mpolicy.bandWorker',
  explorer: 'mpolicy.bandExplorer',
  reviewer: 'mpolicy.bandReviewer',
  midEscalation: 'mpolicy.bandMidEscalation',
  escalation: 'mpolicy.bandEscalation',
};

function BandRow({
  name,
  band,
  keyMissing,
  onChange,
}: {
  name: BandName;
  band: ModelBand;
  keyMissing: boolean;
  onChange: (next: ModelBand) => void;
}): JSX.Element {
  const t = useT();
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-56 shrink-0 text-zinc-400">{t(BAND_LABEL[name])}</span>
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
          <option value="moonshot">Moonshot(Kimi)</option>
        </select>
        <select
          className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1"
          value={band.model}
          onChange={(e) => onChange({ ...band, model: e.target.value })}
        >
          <option value=''>{t('mpolicy.bandDefault', { model: DEFAULT_MODELS[band.provider] })}</option>
          {KNOWN_MODELS[band.provider].map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {keyMissing && (
        <p className="pl-56 text-[11px] text-amber-400">
          {t('mpolicy.keyMissing', { provider: band.provider })}
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

  const t = useT();
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
        {t('mpolicy.heading')}
      </label>
      {enabled && policy && (
        <div className="space-y-2 rounded border border-zinc-700 bg-zinc-950/50 p-2">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.labelKey}
                className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                onClick={() => save({ enabled: true, ...p.policy })}
              >
                {t(p.labelKey)}
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
            name="explorer"
            band={policy.explorer ?? policy.worker}
            keyMissing={keyMissing((policy.explorer ?? policy.worker).provider)}
            onChange={(b) => save({ ...policy, explorer: b })}
          />
          <BandRow
            name="reviewer"
            band={policy.reviewer ?? policy.planner}
            keyMissing={keyMissing((policy.reviewer ?? policy.planner).provider)}
            onChange={(b) => save({ ...policy, reviewer: b })}
          />
          <BandRow
            name="midEscalation"
            band={policy.midEscalation ?? policy.escalation ?? policy.planner}
            keyMissing={keyMissing((policy.midEscalation ?? policy.escalation ?? policy.planner).provider)}
            onChange={(b) => save({ ...policy, midEscalation: b })}
          />
          <BandRow
            name="escalation"
            band={policy.escalation ?? policy.planner}
            keyMissing={keyMissing((policy.escalation ?? policy.planner).provider)}
            onChange={(b) => save({ ...policy, escalation: b })}
          />
          <div className="flex items-center gap-2 text-xs">
            <span className="w-56 shrink-0 text-zinc-400">{t('mpolicy.maxEscalations')}</span>
            <select
              className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1"
              value={policy.maxEscalationsPerTask ?? 1}
              onChange={(e) =>
                save({ ...policy, maxEscalationsPerTask: Number(e.target.value) })
              }
            >
              <option value={0}>{t('mpolicy.esc0')}</option>
              <option value={1}>{t('mpolicy.esc1')}</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          {/* 現在の割り当て一覧 */}
          <p className="text-[11px] leading-relaxed text-zinc-500">
            {t('mpolicy.currentPre')}
            {t('mpolicy.sumMain')} = {policy.planner.provider}/{effective(policy.planner)} ・
            {t('mpolicy.sumWorker')} = {policy.worker.provider}/{effective(policy.worker)} ・
            {t('mpolicy.sumExplorer')} = {(policy.explorer ?? policy.worker).provider}/
            {effective(policy.explorer ?? policy.worker)} ・
            {t('mpolicy.sumReviewer')} = {(policy.reviewer ?? policy.planner).provider}/
            {effective(policy.reviewer ?? policy.planner)} ・
            {t('mpolicy.sumEscalation')} = {(policy.midEscalation ?? policy.escalation ?? policy.planner).provider}/
            {effective(policy.midEscalation ?? policy.escalation ?? policy.planner)} →{' '}
            {(policy.escalation ?? policy.planner).provider}/
            {effective(policy.escalation ?? policy.planner)}
            {t('mpolicy.currentSummary')}
          </p>
        </div>
      )}
      {!enabled && (
        <p className="text-xs text-zinc-500">{t('mpolicy.offNote')}</p>
      )}
    </div>
  );
}
