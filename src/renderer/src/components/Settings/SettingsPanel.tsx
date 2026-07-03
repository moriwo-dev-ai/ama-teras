import { useEffect, useState } from 'react';
import type { AppConfig, ProviderId, SecretsStatus } from '../../../../shared/types';

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void window.api.settingsGet().then(setConfig);
    void window.api.secretsStatus().then(setStatus);
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
      <div className="w-[520px] max-w-[90vw] space-y-4 rounded-lg border border-zinc-600 bg-zinc-900 p-5 text-sm shadow-xl">
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
            <option value="openai">OpenAI(M6で対応予定)</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400">モデル(空欄で既定: claude-opus-4-8)</label>
          <input
            className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
            value={config.model}
            placeholder="claude-opus-4-8"
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
            onBlur={() => void updateConfig({ model: config.model })}
          />
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

        {notice && <p className="text-xs text-zinc-400">{notice}</p>}
      </div>
    </div>
  );
}
