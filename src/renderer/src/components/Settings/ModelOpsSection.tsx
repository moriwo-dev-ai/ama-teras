import type { AppConfig, SecretsStatus } from '../../../../shared/types';
import { useT } from '../../i18n';
import { ModelPolicySection } from './ModelPolicySection';

/**
 * M26-5: 設定「モデル運用」タブ — ModelPolicy / フォールバック / 最大ターン数 /
 * サブエージェント設定。状態は SettingsPanel に集約し props で受ける
 */
export function ModelOpsSection({
  config,
  secrets,
  saveConfig,
}: {
  config: AppConfig;
  secrets: SecretsStatus | null;
  saveConfig: (next: AppConfig) => void;
}): JSX.Element {
  const t = useT();
  return (
    <div className="space-y-4">
      {/* M18: モデル自動切替(役割ベース割当) */}
      <ModelPolicySection config={config} secrets={secrets} onSave={saveConfig} />

      <div className="space-y-1 rounded-md border border-zinc-700 p-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
          <input
            type="checkbox"
            checked={config.fallback?.enabled === true}
            onChange={(e) => {
              saveConfig({
                ...config,
                fallback: {
                  enabled: e.target.checked,
                  provider:
                    config.fallback?.provider ??
                    (config.provider === 'anthropic' ? 'openai' : 'anthropic'),
                  model: config.fallback?.model ?? '',
                },
              });
            }}
          />
          {t('mops.fallbackHeading')}
        </label>
        {config.fallback?.enabled === true && (
          <div className="flex items-center gap-2 text-xs">
            <select
              className="rounded border border-zinc-600 bg-zinc-800 px-2 py-1"
              value={config.fallback.provider}
              onChange={(e) => {
                saveConfig({
                  ...config,
                  fallback: {
                    ...config.fallback!,
                    provider:
                      e.target.value === 'openai' ? 'openai' : e.target.value === 'moonshot' ? 'moonshot' : 'anthropic',
                  },
                });
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="moonshot">Moonshot(Kimi)</option>
            </select>
            <input
              className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono"
              placeholder={t('mops.fallbackModelPh')}
              defaultValue={config.fallback.model}
              onBlur={(e) => {
                saveConfig({
                  ...config,
                  fallback: { ...config.fallback!, model: e.target.value.trim() },
                });
              }}
            />
          </div>
        )}
        <p className="text-xs text-zinc-500">
          {t('mops.fallbackNote')}
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">{t('mops.maxTurns')}</label>
        <input
          type="number"
          min={1}
          max={200}
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          defaultValue={config.maxTurns ?? ''}
          placeholder={t('mops.default30')}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next: AppConfig = { ...config };
            delete next.maxTurns;
            const n = Number(raw);
            if (raw !== '' && Number.isFinite(n)) {
              next.maxTurns = Math.min(200, Math.max(1, Math.round(n)));
            }
            saveConfig(next);
          }}
        />
        <p className="text-xs text-zinc-500">
          {t('mops.maxTurnsNote')}
        </p>
      </div>

      {/* M92-A6: 自己進化の並列生成数 */}
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">{t('mops.evoConcurrency')}</label>
        <input
          type="number"
          min={1}
          max={4}
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          defaultValue={config.evolutionConcurrency ?? ''}
          placeholder={t('mops.default2')}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next: AppConfig = { ...config };
            delete next.evolutionConcurrency;
            const n = Number(raw);
            if (raw !== '' && Number.isFinite(n)) {
              next.evolutionConcurrency = Math.min(4, Math.max(1, Math.round(n)));
            }
            saveConfig(next);
          }}
        />
        <p className="text-xs text-zinc-500">
          {t('mops.evoConcurrencyNote')}
        </p>
      </div>

      {/* M92-A6-3: 生成トークンの予算ガード(従量課金の暴走止め) */}
      <div className="space-y-1 rounded-md border border-zinc-700 p-3">
        <div className="text-xs font-semibold text-zinc-300">{t('mops.tokenCapHeading')}</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs text-zinc-400">{t('mops.sessionCap')}</label>
            <input
              type="number"
              min={0}
              step={10000}
              className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
              defaultValue={config.evolutionSessionTokenCap ?? ''}
              placeholder={t('mops.unlimited')}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const next: AppConfig = { ...config };
                delete next.evolutionSessionTokenCap;
                const n = Number(raw);
                if (raw !== '' && Number.isFinite(n) && n > 0) {
                  next.evolutionSessionTokenCap = Math.round(n);
                }
                saveConfig(next);
              }}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-zinc-400">{t('mops.perJobCap')}</label>
            <input
              type="number"
              min={0}
              step={10000}
              className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
              defaultValue={config.evolutionPerJobTokenCap ?? ''}
              placeholder={t('mops.unlimited')}
              onBlur={(e) => {
                const raw = e.target.value.trim();
                const next: AppConfig = { ...config };
                delete next.evolutionPerJobTokenCap;
                const n = Number(raw);
                if (raw !== '' && Number.isFinite(n) && n > 0) {
                  next.evolutionPerJobTokenCap = Math.round(n);
                }
                saveConfig(next);
              }}
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          {t('mops.tokenCapNote')}
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">{t('mops.subTurns')}</label>
        <input
          type="number"
          min={1}
          max={100}
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          defaultValue={config.subAgentMaxTurns ?? ''}
          placeholder={t('mops.default30')}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next: AppConfig = { ...config };
            delete next.subAgentMaxTurns;
            const n = Number(raw);
            if (raw !== '' && Number.isFinite(n)) {
              next.subAgentMaxTurns = Math.min(100, Math.max(1, Math.round(n)));
            }
            saveConfig(next);
          }}
        />
        <p className="text-xs text-zinc-500">
          {t('mops.subTurnsNote')}
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">{t('mops.subParallel')}</label>
        <select
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          value={config.subAgentMaxParallel ?? 3}
          onChange={(e) => {
            const n = Number(e.target.value);
            const next: AppConfig = { ...config };
            if (n === 3) delete next.subAgentMaxParallel;
            else next.subAgentMaxParallel = n;
            saveConfig(next);
          }}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 3 ? t('mops.defaultMark') : ''}
            </option>
          ))}
        </select>
        <p className="text-xs text-zinc-500">
          {t('mops.subParallelNote')}
        </p>
      </div>
    </div>
  );
}
