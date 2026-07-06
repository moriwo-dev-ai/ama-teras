import { useEffect, useState } from 'react';
import type { AppConfig, ProviderId, SecretsStatus } from '../../../../shared/types';
import { DEFAULT_MODELS, KNOWN_MODELS, isKnownModel } from '../../../../shared/models';
import { animEnabled, setAnimEnabled } from '../../lib/animPref';
import { McpSection } from './McpSection';
import { ModelPolicySection } from './ModelPolicySection';
import { RemoteAccessSection } from './RemoteAccessSection';
import { ReviewGateSection } from './ReviewGateSection';

const CUSTOM = '__custom__';

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [notice, setNotice] = useState('');
  const [memory, setMemory] = useState('');
  // fullPc 有効化は影響が大きいため確認モーダルを挟む(M9-4)
  const [confirmFullPc, setConfirmFullPc] = useState(false);
  const [animOn, setAnimOn] = useState(animEnabled());

  useEffect(() => {
    void window.api.settingsGet().then(setConfig);
    void window.api.secretsStatus().then(setStatus);
    void window.api.memoryGet().then(setMemory);
  }, []);

  if (!config) return <div className="p-4 text-sm text-zinc-400">読込中…</div>;

  const updateConfig = async (patch: Partial<AppConfig>): Promise<void> => {
    const next = { ...config, ...patch };
    setConfig(await window.api.settingsSet(next));
  };

  const saveKey = async (): Promise<void> => {
    if (!apiKey.trim()) return;
    try {
      setStatus(await window.api.secretsSet(config.provider, apiKey));
      setApiKey('');
      setNotice('APIキーを保存した(OS暗号化ストレージ)');
    } catch (err) {
      setNotice(`保存失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const keySet = config.provider === 'anthropic' ? status?.anthropic : status?.openai;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      <div className="max-h-[90vh] w-[520px] max-w-[90vw] space-y-4 overflow-y-auto rounded-lg border border-zinc-600 bg-zinc-900 p-5 text-sm shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">設定</h2>
          <button className="text-zinc-400 hover:text-zinc-200" onClick={onClose}>
            ✕ 閉じる
          </button>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">プロバイダ</label>
          <select
            className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
            value={config.provider}
            onChange={(e) => void updateConfig({ provider: e.target.value as ProviderId })}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">モデル</label>
          {(() => {
            // 空欄=既定。候補外の値は「カスタム」として自由入力欄を出す(誤入力事故の防止)。
            const isCustom = config.model !== '' && !isKnownModel(config.provider, config.model);
            const selectValue = config.model === '' ? '' : isCustom ? CUSTOM : config.model;
            return (
              <>
                <select
                  className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
                  value={selectValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === CUSTOM) setConfig({ ...config, model: ' ' }); // カスタム欄を開く(空白は保存時にtrim)
                    else void updateConfig({ model: v });
                  }}
                >
                  <option value="">既定({DEFAULT_MODELS[config.provider]})</option>
                  {KNOWN_MODELS[config.provider].map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  <option value={CUSTOM}>カスタム(モデルIDを直接入力)</option>
                </select>
                {(isCustom || selectValue === CUSTOM) && (
                  <input
                    className="mt-1 w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
                    value={config.model.trim()}
                    placeholder="例: claude-opus-4-8"
                    autoFocus
                    onChange={(e) => setConfig({ ...config, model: e.target.value })}
                    onBlur={() => void updateConfig({ model: config.model.trim() })}
                  />
                )}
              </>
            );
          })()}
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">
            APIキー {keySet ? '(設定済み。再入力で上書き)' : '(未設定)'}
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
              value={apiKey}
              placeholder="sk-ant-…"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-40"
              disabled={!apiKey.trim()}
              onClick={() => void saveKey()}
            >
              保存
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">作業ディレクトリ(エージェントがファイル操作する場所)</label>
          <div className="flex gap-2">
            <input
              readOnly
              className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-300"
              value={config.workspace && config.workspace.trim() !== '' ? config.workspace : '(既定: アプリのルート)'}
            />
            <button
              className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
              onClick={async () => {
                const picked = await window.api.pickWorkspace();
                if (picked) void updateConfig({ workspace: picked });
              }}
            >
              選択…
            </button>
            {config.workspace && (
              <button
                className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
                onClick={() => void updateConfig({ workspace: '' })}
              >
                既定に戻す
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">操作範囲(scopeMode)</label>
          <div className="space-y-1 text-xs text-zinc-300">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scopeMode"
                checked={config.scopeMode === 'project'}
                onChange={() => void updateConfig({ scopeMode: 'project' })}
              />
              project — 作業ディレクトリ内のみ(既定・従来どおり)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scopeMode"
                checked={config.scopeMode === 'fullPc'}
                onChange={() => {
                  if (config.scopeMode !== 'fullPc') setConfirmFullPc(true);
                }}
              />
              fullPc — PC全体を承認制で許可(プロジェクト外は毎回承認)
            </label>
          </div>
          {config.scopeMode === 'fullPc' && (
            <p className="text-xs text-amber-400">
              ⚠ fullPc 有効中: プロジェクト外の操作は毎回承認ダイアログが出る(自動承認・セッション許可は無効)
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={config.fullPcAllowSession === true}
              onChange={(e) => {
                const next: AppConfig = { ...config };
                if (e.target.checked) next.fullPcAllowSession = true;
                else delete next.fullPcAllowSession;
                void window.api.settingsSet(next).then(setConfig);
              }}
            />
            fullPc時の「セッション中許可(このフォルダ)」を有効化(M14-5)
          </label>
          {config.fullPcAllowSession === true && (
            <p className="text-xs text-amber-400">
              ⚠ 放置作業の利便と引き換えに、許可したフォルダへの書き込みがセッション中
              ノーチェックになる(ツール×フォルダ単位。bash等の実行系と保護領域は対象外。
              自動通過も全件 audit.jsonl に記録)
            </p>
          )}
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
              void window.api.settingsSet(next).then(setConfig);
            }}
          />
          <p className="text-xs text-zinc-500">
            1回の指示でエージェントが自走できる最大ターン数(1〜200)。大きいほど長いタスクを
            続けられるがAPIコストが増える。空欄=既定(30)
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
              void window.api.settingsSet(next).then(setConfig);
            }}
          />
          <p className="text-xs text-zinc-500">
            dispatch_agent(mode:"work" / parallel)の子エージェント1体あたりの上限(1〜100)。空欄=既定(30)
          </p>
        </div>

        <div className="space-y-1 rounded-md border border-zinc-700 p-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <input
              type="checkbox"
              checked={config.fallback?.enabled === true}
              onChange={(e) => {
                const next: AppConfig = {
                  ...config,
                  fallback: {
                    enabled: e.target.checked,
                    provider:
                      config.fallback?.provider ??
                      (config.provider === 'anthropic' ? 'openai' : 'anthropic'),
                    model: config.fallback?.model ?? '',
                  },
                };
                void window.api.settingsSet(next).then(setConfig);
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
                  const next: AppConfig = {
                    ...config,
                    fallback: {
                      ...config.fallback!,
                      provider: e.target.value === 'openai' ? 'openai' : 'anthropic',
                    },
                  };
                  void window.api.settingsSet(next).then(setConfig);
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
                  const next: AppConfig = {
                    ...config,
                    fallback: { ...config.fallback!, model: e.target.value.trim() },
                  };
                  void window.api.settingsSet(next).then(setConfig);
                }}
              />
            </div>
          )}
          <p className="text-xs text-zinc-500">
            課金/残高エラーを検知すると、その会話の実行だけ切替先で自動続行する(本体のプロバイダ設定は
            変更しない・1会話につき1回まで・発動は audit.jsonl に記録)。切替先のAPIキー登録が必要
          </p>
        </div>

        {/* M18: モデル自動切替(役割ベース割当) */}
        <ModelPolicySection
          config={config}
          secrets={status}
          onSave={(next) => void window.api.settingsSet(next).then(setConfig)}
        />

        {/* M19: 品質レビュー・ゲート */}
        <ReviewGateSection
          config={config}
          onSave={(next) => void window.api.settingsSet(next).then(setConfig)}
        />

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={animOn}
              onChange={(e) => {
                setAnimEnabled(e.target.checked);
                setAnimOn(e.target.checked);
              }}
            />
            アニメーション(UIの表示効果)
          </label>
          <p className="text-xs text-zinc-500">
            メッセージ表示・タブ切替などの控えめな動き。OSの「視差効果を減らす」設定が
            有効な場合はONでも動かない(この設定はこのPCにのみ保存)
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">編集後フック(postEditHook)</label>
          <input
            className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
            defaultValue={config.postEditHook ?? ''}
            placeholder="例: npx vitest run --changed"
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const next: AppConfig = { ...config };
              delete next.postEditHook;
              if (raw !== '') next.postEditHook = raw;
              void window.api.settingsSet(next).then(setConfig);
            }}
          />
          <p className="text-xs text-zinc-500">
            write_file / edit_file が成功するたびに作業ディレクトリで実行され、出力(末尾4KB)が
            ツール結果に追記される。エラーをモデルが見て自走修正できる(タイムアウト60秒・空欄=無効)
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">ツール自動承認</label>
          <div className="flex gap-4 text-xs text-zinc-300">
            {(['safe', 'write', 'exec'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={config.autoApprove[k]}
                  onChange={() =>
                    void updateConfig({
                      autoApprove: { ...config.autoApprove, [k]: !config.autoApprove[k] },
                    })
                  }
                />
                {k}
              </label>
            ))}
          </div>
        </div>

        <RemoteAccessSection />

        <McpSection />

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">
            プロジェクト記憶(AMATERAS.md・作業フォルダに保存され system プロンプトへ注入)
          </label>
          <textarea
            className="h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
            value={memory}
            placeholder={'例:\n- 返答は必ず日本語\n- このリポジトリのテストは vitest'}
            onChange={(e) => setMemory(e.target.value)}
          />
          <button
            className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
            onClick={async () => {
              await window.api.memorySet(memory);
              setNotice('プロジェクト記憶を保存した(AMATERAS.md)');
            }}
          >
            記憶を保存
          </button>
        </div>

        {notice && <p className="text-xs text-zinc-400">{notice}</p>}
      </div>

      {confirmFullPc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[440px] max-w-[90vw] space-y-3 rounded-lg border border-amber-600 bg-zinc-900 p-5 text-sm shadow-xl">
            <h3 className="font-semibold text-amber-400">⚠ PC全体スコープを有効にする</h3>
            <p className="text-xs leading-relaxed text-zinc-300">
              エージェントが作業ディレクトリの外(デスクトップ・ドキュメント等、PC全体)の
              ファイル操作とコマンド実行を要求できるようになる。プロジェクト外の操作は
              risk や自動承認設定に関係なく<span className="font-semibold text-amber-300">毎回</span>
              承認ダイアログで確認される。アプリ設定領域(userData)と Windows システム領域への
              書き込みは引き続き拒否される。
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="rounded-md border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800"
                onClick={() => setConfirmFullPc(false)}
              >
                キャンセル
              </button>
              <button
                className="rounded-md bg-amber-600 px-4 py-1.5 text-sm hover:bg-amber-500"
                onClick={() => {
                  setConfirmFullPc(false);
                  void updateConfig({ scopeMode: 'fullPc' });
                }}
              >
                有効にする
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
