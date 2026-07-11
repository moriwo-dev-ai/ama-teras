import { useEffect, useState } from 'react';
import type { AppConfig, ModelBand, OperationsConfig } from '../../../../shared/types';
import { DEFAULT_REGISTRY_URL, KNOWN_MODELS } from '../../../../shared/models';
import { useOperationsStore } from '../../stores/operations';
import { McpSection } from './McpSection';
import { RemoteAccessSection } from './RemoteAccessSection';
import { UsageSection } from './UsageSection';

/**
 * M34-7: 運営専用モデル帯の選択(神議/神々)。
 * 推奨: 神議=Sonnet系(分析品質と単価のバランス。planner=Fable5のままだと
 * 1日2回の定例だけで月1万円級になる)、神々=未設定(worker帯)のまま
 */
const OPS_BAND_CUSTOM = '__custom__';

function OpsBandPicker({
  label,
  hint,
  band,
  onChange,
}: {
  label: string;
  hint: string;
  band: ModelBand | undefined;
  onChange: (band: ModelBand | undefined) => void;
}): JSX.Element {
  // M36-2: モデルは基本タブと同じリスト選択式(KNOWN_MODELS)。自由入力は「カスタム」選択時のみ
  const known = band !== undefined ? KNOWN_MODELS[band.provider] : [];
  const isCustomModel = band !== undefined && band.model !== '' && !known.some((m) => m.id === band.model);
  const [customOpen, setCustomOpen] = useState(false);
  const selectValue = band === undefined ? '' : isCustomModel || customOpen ? OPS_BAND_CUSTOM : band.model;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="w-28 shrink-0 text-zinc-400">{label}</span>
      <select
        className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1 text-xs"
        value={band?.provider ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          setCustomOpen(false);
          onChange(v === '' ? undefined : { provider: v as ModelBand['provider'], model: '' });
        }}
      >
        <option value="">{hint}</option>
        <option value="anthropic">anthropic</option>
        <option value="openai">openai</option>
      </select>
      {band !== undefined && (
        <>
          <select
            className="min-w-[12rem] rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1 text-xs"
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === OPS_BAND_CUSTOM) {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange({ provider: band.provider, model: v });
            }}
          >
            <option value="">(プロバイダ既定)</option>
            {known.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value={OPS_BAND_CUSTOM}>カスタム(モデルIDを直接入力)</option>
          </select>
          {(isCustomModel || customOpen) && (
            <input
              className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
              placeholder="モデルID"
              defaultValue={isCustomModel ? band.model : ''}
              autoFocus={customOpen}
              onBlur={(e) => {
                const v = e.target.value.trim();
                setCustomOpen(false);
                onChange({ provider: band.provider, model: v });
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * M35-4: Bluesky実行系の資格情報(identifier + app password)。
 * secretsの 'bluesky' スロットにJSONで保存(safeStorage暗号化)。
 * 登録すると bluesky アダプタの execute(post/follow/reply・岩戸ゲート承認制)が有効化される
 */
function BlueskyCredsSection(): JSX.Element {
  const [identifier, setIdentifier] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    void window.api.secretsStatus().then((s) => setRegistered(s.bluesky));
  }, []);
  return (
    <div className="space-y-1 rounded border border-zinc-800 p-2">
      <p className="text-xs font-semibold text-zinc-300">
        Bluesky実行系(フォロー・投稿・返信){registered === true ? '(設定済み)' : '(未設定=提案のみ)'}
      </p>
      <p className="text-[10px] text-zinc-500">
        app passwordを登録すると、承認したフォロー・投稿を岩戸ゲート経由で実行できる
        (bsky.app → Settings → App Passwords で発行。メインパスワードは絶対に入れない)。
        プロフィールに「一部運用を自動化(承認制)」の開示を推奨
      </p>
      <div className="flex flex-wrap gap-1.5">
        <input
          className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
          placeholder="ハンドル(例: moriwo.bsky.social)"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value.trim())}
        />
        <input
          type="password"
          className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
          placeholder="app password(xxxx-xxxx-xxxx-xxxx)"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value.trim())}
        />
        <button
          className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500 disabled:opacity-40"
          disabled={identifier === '' || appPassword === ''}
          onClick={() => {
            void window.api
              .secretsSet('bluesky', JSON.stringify({ identifier, appPassword }))
              .then((s) => {
                setRegistered(s.bluesky);
                setIdentifier('');
                setAppPassword('');
                setNotice('保存した(実行系が有効化された。実行は毎回あなたの承認制)');
              })
              .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
          }}
        >
          保存
        </button>
      </div>
      {notice !== '' && <p className="text-[10px] text-zinc-400">{notice}</p>}
    </div>
  );
}

/** M34-7: 運営の今日の実測コスト(usage帯別集計の kamuhakari/gods 行) */
function OpsCostToday(): JSX.Element | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void window.api.usageGet().then((summary) => {
      const row = (band: string): number | null =>
        summary.bands.find((b) => b.band === band)?.today.costUsd ?? null;
      const kamu = row('kamuhakari');
      const gods = row('gods');
      if (kamu === null && gods === null) {
        setText('今日の運営コスト実測: まだ記録なし(次回再起動後の実行から kamuhakari/gods として集計)');
      } else {
        const total = (kamu ?? 0) + (gods ?? 0);
        setText(`今日の運営コスト実測: $${total.toFixed(2)}(神議 $${(kamu ?? 0).toFixed(2)} / 神々 $${(gods ?? 0).toFixed(2)})→ 推定月額 $${(total * 30).toFixed(0)}`);
      }
    });
  }, []);
  return text === null ? null : <p className="text-[10px] text-zinc-500">{text}</p>;
}

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
          {/* M34-1: はてブ監視URL(Zenn記事は自動導出されるので追加分のみ) */}
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">
              はてブ数の監視URL(改行区切り・任意。Zenn記事はスラッグから自動導出される)
            </p>
            <textarea
              className="h-12 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={(ops.watchUrls ?? []).join('\n')}
              placeholder="https://github.com/moriwo-dev-ai/ama-teras"
              onBlur={(e) => {
                const watchUrls = e.target.value.split('\n').map((u) => u.trim()).filter((u) => u !== '');
                save({ ...ops, ...(watchUrls.length > 0 ? { watchUrls } : { watchUrls: undefined as never }) });
              }}
            />
          </div>
          {/* M34-2: HN監視(読み取りのみ) */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-400">HNユーザー(karma・返信監視)</span>
            <input
              className="rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
              defaultValue={ops.hnUser ?? ''}
              placeholder="moriwo-dev-ai"
              onBlur={(e) => {
                const v = e.target.value.trim();
                save({ ...ops, ...(v !== '' ? { hnUser: v } : { hnUser: undefined as never }) });
              }}
            />
          </div>
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">HN監視スレッド(item?id=のURLかID・改行区切り)</p>
            <textarea
              className="h-12 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={(ops.hnThreads ?? []).join('\n')}
              placeholder="https://news.ycombinator.com/item?id=48845422"
              onBlur={(e) => {
                const hnThreads = e.target.value.split('\n').map((t) => t.trim()).filter((t) => t !== '');
                save({ ...ops, ...(hnThreads.length > 0 ? { hnThreads } : { hnThreads: undefined as never }) });
              }}
            />
          </div>
          {/* M34-7: 運営専用モデル帯(コスト管理) */}
          <div className="space-y-1 rounded border border-zinc-800 p-2">
            <p className="text-xs font-semibold text-zinc-300">運営専用モデル(コスト管理)</p>
            <p className="text-[10px] text-zinc-500">
              神議は1日2回・planner帯(最上位モデル)で動くため運営コストの大半を占める。
              推奨: 神議=Sonnet系 / 神々=未設定(worker帯)のまま
            </p>
            <OpsBandPicker
              label="神議(分析・週報)"
              hint="(従来どおり planner帯)"
              band={ops.kamuhakariBand}
              onChange={(band) =>
                save({ ...ops, ...(band !== undefined ? { kamuhakariBand: band } : { kamuhakariBand: undefined as never }) } as OperationsConfig)
              }
            />
            <OpsBandPicker
              label="神々(判定・下書き)"
              hint="(従来どおり worker帯)"
              band={ops.godsBand}
              onChange={(band) =>
                save({ ...ops, ...(band !== undefined ? { godsBand: band } : { godsBand: undefined as never }) } as OperationsConfig)
              }
            />
            <OpsCostToday />
          </div>
          <BlueskyCredsSection />
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
