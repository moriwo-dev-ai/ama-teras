import type { AppConfig } from '../../../../shared/types';
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

      {/* M28-3: コミュニティレジストリ(作る前に探す) */}
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">コミュニティレジストリURL(作る前に探す)</label>
        <input
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          defaultValue={config.registryUrl ?? ''}
          placeholder="例: https://raw.githubusercontent.com/<owner>/amateras-registry/main(空欄=検索しない)"
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next: AppConfig = { ...config };
            delete next.registryUrl;
            if (raw !== '') next.registryUrl = raw;
            saveConfig(next);
          }}
        />
        <p className="text-xs text-zinc-500">
          エージェントが新しいツールを作る前にレジストリを検索し、コミュニティの既存プラグインが
          あれば提案する(承諾すると検証ゲート付きでインポート)。未達・候補なしのときは
          静かに従来の生成へフォールバックする
        </p>
      </div>

      <RemoteAccessSection />
      <McpSection />
    </div>
  );
}
