import { useEffect, useState } from 'react';
import type { AppConfig, PluginErrorInfo, ToolInfo } from '../../../../shared/types';

/** M2の動作確認用パネル。ツールを手動実行して承認フロー込みで検証する */
export function ToolDebugPanel(): JSX.Element {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [errors, setErrors] = useState<PluginErrorInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [result, setResult] = useState<{ content: string; isError: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);

  const refresh = async (reload: boolean): Promise<void> => {
    const r = reload ? await window.api.toolsReload() : await window.api.toolsList();
    setTools(r.tools);
    setErrors(r.errors);
    if (r.tools.length > 0 && !r.tools.some((t) => t.name === selected)) {
      setSelected(r.tools[0]?.name ?? '');
    }
  };

  useEffect(() => {
    void refresh(false);
    void window.api.settingsGet().then(setConfig);
    // eslint的には依存が要るが初回のみで良い
  }, []);

  const run = async (): Promise<void> => {
    if (!selected) return;
    setRunning(true);
    setResult(null);
    try {
      setResult(await window.api.toolsExecute(selected, inputJson));
    } finally {
      setRunning(false);
    }
  };

  const toggleAuto = async (key: keyof AppConfig['autoApprove']): Promise<void> => {
    if (!config) return;
    const next: AppConfig = {
      ...config,
      autoApprove: { ...config.autoApprove, [key]: !config.autoApprove[key] },
    };
    setConfig(await window.api.settingsSet(next));
  };

  return (
    <div className="space-y-2 border-t border-zinc-700 bg-zinc-950 p-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-zinc-400">ツールデバッグ</span>
        <select
          className="rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.risk})
            </option>
          ))}
        </select>
        <button
          className="rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500 disabled:opacity-40"
          disabled={running || !selected}
          onClick={() => void run()}
        >
          {running ? '実行中…' : '実行'}
        </button>
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
          onClick={() => void refresh(true)}
        >
          プラグイン再読込
        </button>
        {config && (
          <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
            自動承認:
            {(['safe', 'write', 'exec'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={config.autoApprove[k]}
                  onChange={() => void toggleAuto(k)}
                />
                {k}
              </label>
            ))}
          </div>
        )}
      </div>
      <textarea
        className="h-16 w-full resize-none rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
        value={inputJson}
        onChange={(e) => setInputJson(e.target.value)}
        placeholder='入力JSON(例: {"path": "package.json"})'
      />
      {errors.length > 0 && (
        <div className="rounded border border-red-700 bg-red-950 p-2 text-xs text-red-300">
          {errors.map((e, i) => (
            <div key={i}>
              プラグインロード失敗 {e.filePath}: {e.message}
            </div>
          ))}
        </div>
      )}
      {result && (
        <pre
          className={`max-h-48 overflow-auto rounded border p-2 text-xs ${
            result.isError ? 'border-red-700 bg-red-950 text-red-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300'
          }`}
        >
          {result.content}
        </pre>
      )}
    </div>
  );
}
