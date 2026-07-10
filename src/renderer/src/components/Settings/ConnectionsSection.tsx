import type { AppConfig } from '../../../../shared/types';
import { DEFAULT_REGISTRY_URL } from '../../../../shared/models';
import { McpSection } from './McpSection';
import { RemoteAccessSection } from './RemoteAccessSection';
import { UsageSection } from './UsageSection';

/**
 * M26-5: 設定「接続」タブ — リモートアクセス / MCP / 使用量。
 * M28-3: コミュニティレジストリURL(「作る前に探す」)を追加
 */
export function ConnectionsSection({
  config,
  saveConfig,
}: {
  config: AppConfig;
  saveConfig: (next: AppConfig) => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <UsageSection />

      {/* M28-3/M29-4: コミュニティレジストリ(作る前に探す) */}
      <div className="space-y-1">
        <p className="text-xs font-semibold text-zinc-300">コミュニティレジストリ</p>
        <p className="text-xs text-zinc-500">
          「作る前に探す」— エージェントが新しいツールを作る前にレジストリを検索し、
          コミュニティの既存プラグインがあれば提案する(承諾すると検証ゲート付きでインポート)。
          未達・候補なしのときは静かに従来の生成へフォールバックする。
          既定は公式レジストリ。社内レジストリ等のURLに変更もできる
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            key={config.registryUrl /* 「既定に戻す」での上書きを反映するため */}
            className="min-w-[12rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
            defaultValue={config.registryUrl ?? ''}
            placeholder="レジストリのベースURL(index.json をこの直下から取得)"
            onBlur={(e) => {
              const raw = e.target.value.trim();
              saveConfig({ ...config, registryUrl: raw });
            }}
          />
          <button
            className="shrink-0 whitespace-nowrap rounded border border-zinc-600 px-2 py-1.5 text-xs hover:bg-zinc-800"
            title={DEFAULT_REGISTRY_URL}
            onClick={() => saveConfig({ ...config, registryUrl: DEFAULT_REGISTRY_URL })}
          >
            既定に戻す
          </button>
        </div>
        <p className="text-xs text-zinc-500">空欄にすると検索無効(生成のみになる)</p>
      </div>

      <RemoteAccessSection />
      <McpSection />
    </div>
  );
}
