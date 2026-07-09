import { useState } from 'react';
import type { AppConfig, ProviderId } from '../../../../shared/types';
import { DEFAULT_MODELS, KNOWN_MODELS, isKnownModel } from '../../../../shared/models';

const CUSTOM = '__custom__';

/**
 * M26-5: 設定「基本」タブ — プロバイダ / モデル / APIキー / 作業ディレクトリ / 操作範囲。
 * 状態は SettingsPanel に集約し props で受ける(このファイルはUI-局所状態のみ持つ)
 */
export function BasicSection({
  config,
  setConfig,
  updateConfig,
  saveConfig,
  keySet,
  onSaveKey,
}: {
  config: AppConfig;
  /** ローカルのみの更新(カスタムモデル入力中など、保存前の編集) */
  setConfig: (c: AppConfig) => void;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
  /** キー削除を伴う保存(delete したフィールドを反映するため全量で保存) */
  saveConfig: (next: AppConfig) => void;
  keySet: boolean;
  onSaveKey: (key: string) => Promise<void>;
}): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  // fullPc 有効化は影響が大きいため確認モーダルを挟む(M9-4)
  const [confirmFullPc, setConfirmFullPc] = useState(false);

  return (
    <div className="space-y-4">
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
            onClick={() => {
              void onSaveKey(apiKey).then(() => setApiKey(''));
            }}
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
