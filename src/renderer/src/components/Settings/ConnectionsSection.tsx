import type { AppConfig } from '../../../../shared/types';
import { DEFAULT_REGISTRY_URL } from '../../../../shared/models';
import { useOperationsStore } from '../../stores/operations';
import { McpSection } from './McpSection';
import { RemoteAccessSection } from './RemoteAccessSection';
import { UsageSection } from './UsageSection';

/** M32-1: オーナーモード(運営タブ)。既定OFF=タブ自体を表示しない */
function OwnerModeSection({
  config,
  saveConfig,
}: {
  config: AppConfig;
  saveConfig: (next: AppConfig) => void;
}): JSX.Element {
  const refreshOperations = useOperationsStore((s) => s.refresh);
  const ops = config.operations ?? { enabled: false, repos: [], zennSlugs: [] };
  const save = (next: typeof ops): void => {
    saveConfig({ ...config, operations: next });
    // 保存後にタブ表示・gh検出の状態を反映する
    setTimeout(() => void refreshOperations(), 200);
  };
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-zinc-300">オーナーモード(運営 — Project TAKAMA-gahara)</p>
      <p className="text-xs text-zinc-500">
        自分のリポジトリ・記事の観測、発信ドラフト生成、Issue/PRトリアージを行う
        プロジェクト運営者向けの機能。ONにすると右ペインに「運営」タブが現れる。
        外部への発信(コメント・投稿等)は必ず承認ダイアログ(岩戸ゲート)を通る
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={ops.enabled}
          onChange={(e) => save({ ...ops, enabled: e.target.checked })}
        />
        オーナーモードを有効にする(既定OFF)
      </label>
      {ops.enabled && (
        <div className="space-y-1.5 pl-1 pt-1">
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">観測対象リポジトリ(owner/repo・改行区切り)</p>
            <textarea
              className="h-16 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={ops.repos.join('\n')}
              placeholder={'moriwo-dev-ai/ama-teras\nmoriwo-dev-ai/amateras-registry'}
              onBlur={(e) =>
                save({ ...ops, repos: e.target.value.split('\n').map((r) => r.trim()).filter((r) => r !== '') })
              }
            />
          </div>
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">観測対象Zenn記事スラッグ(改行区切り)</p>
            <textarea
              className="h-12 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={ops.zennSlugs.join('\n')}
              placeholder="ama-teras-self-evolving-agent"
              onBlur={(e) =>
                save({ ...ops, zennSlugs: e.target.value.split('\n').map((s) => s.trim()).filter((s) => s !== '') })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

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

      <OwnerModeSection config={config} saveConfig={saveConfig} />

      <RemoteAccessSection />
      <McpSection />
    </div>
  );
}
