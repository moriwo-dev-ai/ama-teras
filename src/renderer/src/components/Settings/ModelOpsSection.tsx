import type { AppConfig, SecretsStatus } from '../../../../shared/types';
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
          フォールバック(残高切れ時の自動切替)
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
                    provider: e.target.value === 'openai' ? 'openai' : 'anthropic',
                  },
                });
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
            <input
              className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono"
              placeholder="モデル(空欄=切替先の既定)"
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
          課金/残高エラーを検知すると、その会話の実行だけ切替先で自動続行する(本体のプロバイダ設定は
          変更しない・1会話につき1回まで・発動は audit.jsonl に記録)。切替先のAPIキー登録が必要。
          セーフガード拒否(refusal)時は同一プロバイダの1段下モデルで最大2回やり直す(M26-4)
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">最大ターン数(maxTurns)</label>
        <input
          type="number"
          min={1}
          max={200}
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          defaultValue={config.maxTurns ?? ''}
          placeholder="既定: 30"
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
          1回の指示でエージェントが自走できる最大ターン数(1〜200)。大きいほど長いタスクを
          続けられるがAPIコストが増える。空欄=既定(30)
        </p>
      </div>

      {/* M92-A6: 自己進化の並列生成数 */}
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">自己進化の並列生成数(evolutionConcurrency)</label>
        <input
          type="number"
          min={1}
          max={4}
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          defaultValue={config.evolutionConcurrency ?? ''}
          placeholder="既定: 2"
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
          ツールを同時に何個まで生成するか(1〜4・空欄=既定2)。各生成は独立環境で並走するが、
          本体への昇格マージは必ず1件ずつ直列。夜間の大量生成を速くするための設定。大きいほど同時APIコストが立つ
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">サブエージェント最大ターン数(subAgentMaxTurns)</label>
        <input
          type="number"
          min={1}
          max={100}
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          defaultValue={config.subAgentMaxTurns ?? ''}
          placeholder="既定: 30"
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
          dispatch_agent(mode:"work" / parallel)の子エージェント1体あたりの上限(1〜100)。空欄=既定(30)
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">サブエージェント同時実行数(subAgentMaxParallel)</label>
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
              {n === 3 ? '(既定)' : ''}
            </option>
          ))}
        </select>
        <p className="text-xs text-zinc-500">
          dispatch_agent parallel の同時数(1〜8)。実質の制限はAPIレート/コストで、
          429エラーは自動リトライ(M16)が吸収する。同一ファイルへの書き込み衝突は従来どおり拒否される
        </p>
      </div>
    </div>
  );
}
