import { useState } from 'react';
import type {
  AppConfig,
  ProviderId,
  ProviderPresetId,
  SecretSlot,
  SecretsStatus,
} from '../../../../shared/types';
import {
  DEFAULT_MODELS,
  FREE_API_TRAINING_NOTICE,
  KNOWN_MODELS,
  PROVIDER_PRESETS,
  isKnownModel,
} from '../../../../shared/models';
import { applyCustomThemeJson, clearCustomTheme, storedCustomThemeJson } from '../../lib/customTheme';

const CUSTOM = '__custom__';

/**
 * M26-5: 設定「基本」タブ — プロバイダ / モデル / APIキー / 作業ディレクトリ / 操作範囲。
 * M27-1: 「無料で始める」(プリセット+かんたんセットアップ+接続テスト)を追加。
 * 状態は SettingsPanel に集約し props で受ける(このファイルはUI-局所状態のみ持つ)
 */
export function BasicSection({
  config,
  setConfig,
  updateConfig,
  saveConfig,
  secrets,
  onSaveKey,
  onOpenModels,
}: {
  config: AppConfig;
  /** ローカルのみの更新(カスタムモデル入力中など、保存前の編集) */
  setConfig: (c: AppConfig) => void;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
  /** キー削除を伴う保存(delete したフィールドを反映するため全量で保存) */
  saveConfig: (next: AppConfig) => void;
  secrets: SecretsStatus | null;
  onSaveKey: (slot: SecretSlot, key: string) => Promise<void>;
  /** M30-2: モデル運用タブへの導線(ModelPolicy有効時の注意表示から使う) */
  onOpenModels: () => void;
}): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  // fullPc 有効化は影響が大きいため確認モーダルを挟む(M9-4)
  const [confirmFullPc, setConfirmFullPc] = useState(false);
  // M27-1: 接続テストの状態(実行中/結果)
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // M27-6: カスタムテーマ(JSON)の編集・結果表示
  const [themeJson, setThemeJson] = useState(() => storedCustomThemeJson() ?? '');
  const [themeMsg, setThemeMsg] = useState('');

  // M27-1: プリセット(無料APIモード)使用中はキーの保存先スロットもプリセット側
  const preset =
    config.provider === 'openai' && config.providerPreset !== undefined
      ? PROVIDER_PRESETS[config.providerPreset]
      : undefined;
  const keySlot: SecretSlot = preset !== undefined ? preset.id : config.provider;
  const keySet = secrets !== null && secrets[keySlot];

  const selectPreset = (id: ProviderPresetId | ''): void => {
    setTestResult(null);
    const next: AppConfig = { ...config };
    if (id === '') {
      delete next.providerPreset;
      delete next.freeMode;
      delete next.freeModeAllowEvolution;
    } else {
      next.provider = 'openai';
      next.providerPreset = id;
      next.model = '';
      next.freeMode = true; // プリセット選択で自動ON(手動で切替可)
    }
    saveConfig(next);
  };

  const runConnectionTest = (): void => {
    setTesting(true);
    setTestResult(null);
    void window.api
      .connectionTest()
      .then(setTestResult)
      .catch((err: unknown) =>
        setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setTesting(false));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">プロバイダ</label>
        <select
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5"
          value={config.provider}
          onChange={(e) => {
            // プロバイダを手動変更したらプリセット(無料APIモード)は解除する
            const next: AppConfig = { ...config, provider: e.target.value as ProviderId };
            delete next.providerPreset;
            delete next.freeMode;
            delete next.freeModeAllowEvolution;
            saveConfig(next);
          }}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        {preset !== undefined && (
          <p className="text-xs text-zinc-500">
            プリセット使用中: OpenAI互換エンドポイント({preset.baseUrl})で動作
          </p>
        )}
      </div>

      {/* M27-1: 無料で始める(カード登録なしの無料APIプリセット) */}
      <div className="space-y-2 rounded border border-emerald-800 bg-emerald-950/30 p-3">
        <p className="text-xs font-semibold text-emerald-300">
          無料で始める(カード登録なし・無料枠APIで即開始)
        </p>
        <select
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 text-xs"
          value={config.providerPreset ?? ''}
          onChange={(e) => selectPreset(e.target.value as ProviderPresetId | '')}
        >
          <option value="">使わない(Anthropic / OpenAI の有料APIを使う)</option>
          {Object.values(PROVIDER_PRESETS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {preset !== undefined && (
          <>
            <ol className="list-decimal space-y-0.5 pl-5 text-xs text-zinc-300">
              {preset.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <div className="flex items-center gap-2">
              <button
                className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
                onClick={() => void window.api.openBillingPage(preset.id)}
              >
                APIキー取得ページを開く ↗
              </button>
              <button
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs hover:bg-emerald-600 disabled:opacity-40"
                disabled={testing || !keySet}
                title={keySet ? '' : '先に下の欄でAPIキーを保存してください'}
                onClick={runConnectionTest}
              >
                {testing ? '接続テスト中…' : '接続テスト'}
              </button>
            </div>
            {testResult !== null && (
              <p className={`text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {testResult.ok ? '✓ ' : '✗ '}
                {testResult.message}
              </p>
            )}
            <p className="text-xs text-amber-400">ℹ {FREE_API_TRAINING_NOTICE}</p>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={config.freeMode === true}
                onChange={(e) => {
                  const next: AppConfig = { ...config };
                  if (e.target.checked) next.freeMode = true;
                  else {
                    delete next.freeMode;
                    delete next.freeModeAllowEvolution;
                  }
                  saveConfig(next);
                }}
              />
              無料モード(既定を軽量化: maxTurns 15・レビューゲートOFF・ModelPolicy無効)
            </label>
            {config.freeMode === true && (
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={config.freeModeAllowEvolution === true}
                  onChange={(e) => {
                    const next: AppConfig = { ...config };
                    if (e.target.checked) next.freeModeAllowEvolution = true;
                    else delete next.freeModeAllowEvolution;
                    saveConfig(next);
                  }}
                />
                無料モードでも自己進化(新規プラグイン生成)を許可(無料枠を消費しやすい)
              </label>
            )}
          </>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">モデル</label>
        {/* M30-2: ModelPolicy有効時はこの欄ではなく帯設定が使われることを明示 */}
        {config.modelPolicy?.enabled === true && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-amber-700 bg-amber-950/50 p-2 text-xs text-amber-200">
            <span className="min-w-0 flex-1">
              ⚠ モデル自動切替が有効のため、この欄ではなく「モデル運用」タブの帯設定
              (planner/worker等)が使われます
            </span>
            <button
              className="shrink-0 whitespace-nowrap rounded border border-amber-600 px-2 py-0.5 hover:bg-amber-950"
              onClick={onOpenModels}
            >
              モデル運用タブを開く
            </button>
          </div>
        )}
        {(() => {
          // 空欄=既定。候補外の値は「カスタム」として自由入力欄を出す(誤入力事故の防止)。
          // M27-1: プリセット使用中は候補・既定ともプリセット側(モデルIDは提供元都合で
          // 変わりうるためカスタム入力は必ず残す)
          const choices = preset !== undefined ? preset.models : KNOWN_MODELS[config.provider];
          const defaultModel = preset !== undefined ? preset.defaultModel : DEFAULT_MODELS[config.provider];
          const isCustom =
            config.model !== '' &&
            (preset !== undefined
              ? !preset.models.some((m) => m.id === config.model)
              : !isKnownModel(config.provider, config.model));
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
                <option value="">既定({defaultModel})</option>
                {choices.map((m) => (
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
        {/* M26-4: Fable 5 のデータ保持ポリシー注意(選択時のみ) */}
        {config.provider === 'anthropic' &&
          (config.model.trim() === '' ? DEFAULT_MODELS.anthropic : config.model.trim()) ===
            'claude-fable-5' && (
            <p className="text-xs text-amber-400">
              ℹ claude-fable-5 では、入力データは安全対策のため30日間保持されます(ZDR非適用)
            </p>
          )}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">
          APIキー{preset !== undefined ? `(${keySlot} 用)` : ''}{' '}
          {keySet ? '(設定済み。再入力で上書き)' : '(未設定)'}
        </label>
        <div className="flex gap-2">
          <input
            type="password"
            className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
            value={apiKey}
            placeholder={preset !== undefined ? 'APIキーを貼り付け' : 'sk-ant-…'}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            className="shrink-0 whitespace-nowrap rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-40"
            disabled={!apiKey.trim()}
            onClick={() => {
              void onSaveKey(keySlot, apiKey).then(() => setApiKey(''));
            }}
          >
            保存
          </button>
          {/* M30-2: 有料プロバイダ(Anthropic/OpenAI)でも接続テスト(無料プリセットと同じ診断表示) */}
          <button
            className="shrink-0 whitespace-nowrap rounded bg-emerald-700 px-3 py-1.5 text-xs hover:bg-emerald-600 disabled:opacity-40"
            disabled={testing || !keySet}
            title={keySet ? '現在の設定で1リクエスト送って疎通確認する' : '先にAPIキーを保存してください'}
            onClick={runConnectionTest}
          >
            {testing ? 'テスト中…' : '接続テスト'}
          </button>
        </div>
        {testResult !== null && (
          <p className={`whitespace-pre-wrap text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.ok ? '✓ ' : '✗ '}
            {testResult.message}
          </p>
        )}
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
              saveConfig(next);
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

      {/* M27-6(土台): カスタムテーマ(JSON)。将来「見た目の共有=データ流通」の受け口 */}
      <details className="rounded border border-zinc-700 p-2">
        <summary className="cursor-pointer text-xs text-zinc-400">カスタムテーマ(JSON・実験的)</summary>
        <div className="mt-2 space-y-2">
          <textarea
            className="h-28 w-full resize-none rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-[11px]"
            value={themeJson}
            onChange={(e) => setThemeJson(e.target.value)}
            placeholder={`{\n  "name": "my-theme",\n  "base": "dark",\n  "colors": { "bgDeep": "#101418", "accent": "#0f766e" }\n}`}
          />
          <div className="flex items-center gap-2">
            <button
              className="rounded bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600 disabled:opacity-40"
              disabled={themeJson.trim() === ''}
              onClick={() => setThemeMsg(applyCustomThemeJson(themeJson).message)}
            >
              適用
            </button>
            <button
              className="rounded border border-zinc-600 px-3 py-1 text-xs hover:bg-zinc-800"
              onClick={() => {
                clearCustomTheme();
                setThemeMsg('標準テーマに戻した');
              }}
            >
              標準に戻す
            </button>
            {themeMsg !== '' && <span className="text-xs text-zinc-400">{themeMsg}</span>}
          </div>
          <p className="text-[11px] text-zinc-500">
            配色をJSONデータとして定義する(スロット: bgDeep / bgPanel / bgRaised / bgHover /
            border / textMain / textSub / accent / accentText。値は16進カラーのみ)。
            未指定スロットは base(dark/light)の標準値が使われる
          </p>
        </div>
      </details>

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
