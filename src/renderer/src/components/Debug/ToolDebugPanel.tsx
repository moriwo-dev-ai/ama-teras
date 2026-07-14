import { useEffect, useState } from 'react';
import type { AppConfig, CheckpointInfo, PluginErrorInfo, ToolInfo } from '../../../../shared/types';
import { PublishPluginDialog, usePublishPlugin } from '../Registry/PublishPlugin';

/** M2の動作確認用パネル。ツールを手動実行して承認フロー込みで検証する */
export function ToolDebugPanel(): JSX.Element {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [errors, setErrors] = useState<PluginErrorInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [inputJson, setInputJson] = useState('{}');
  const [result, setResult] = useState<{ content: string; isError: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  // M11-3: チェックポイント一覧(最小限のデバッグUI)
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [ckptMsg, setCkptMsg] = useState('');
  // M25-8: ツール一覧のタグ絞り込み・検索
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [toolSearch, setToolSearch] = useState('');
  // M27-4: プラグインエクスポートの結果表示
  const [exportMsg, setExportMsg] = useState('');
  // M91-2: レジストリ公開の下見と承認(送信は承認後の1回だけ)
  const publish = usePublishPlugin();

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

  const loadCheckpoints = async (): Promise<void> => {
    setCheckpoints(await window.api.checkpointList());
  };

  const restoreCheckpoint = async (sha: string): Promise<void> => {
    const r = await window.api.checkpointRestore(sha);
    setCkptMsg(r.message);
    if (r.ok) void loadCheckpoints();
  };

  const toggleAuto = async (key: keyof AppConfig['autoApprove']): Promise<void> => {
    if (!config) return;
    const next: AppConfig = {
      ...config,
      autoApprove: { ...config.autoApprove, [key]: !config.autoApprove[key] },
    };
    setConfig(await window.api.settingsSet(next));
  };

  // M25-8: 全ツールのタグ集合(出現順→アルファベット順にはせず、頻度の高い順にする必要はないため単純にユニーク化)
  const allTags = [...new Set(tools.flatMap((t) => t.tags))].sort();
  const filteredTools = tools.filter((t) => {
    if (tagFilter !== null && !t.tags.includes(tagFilter)) return false;
    if (toolSearch.trim() === '') return true;
    const q = toolSearch.trim().toLowerCase();
    return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-2 border-t border-zinc-700 bg-zinc-950 p-3 text-sm">
      {/* M29-3: 狭幅では折り返す(flex-wrap)。ボタン縦書き化・横スクロールを防ぐ */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-zinc-400">ツールデバッグ</span>
        <select
          className="min-w-0 max-w-full flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
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
          className="shrink-0 whitespace-nowrap rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500 disabled:opacity-40"
          disabled={running || !selected}
          onClick={() => void run()}
        >
          {running ? '実行中…' : '実行'}
        </button>
        <button
          className="shrink-0 whitespace-nowrap rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
          onClick={() => void refresh(true)}
        >
          プラグイン再読込
        </button>
        {config && (
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="whitespace-nowrap">自動承認:</span>
            {(['safe', 'write', 'exec'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1 whitespace-nowrap">
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

      <div className="space-y-1 border-t border-zinc-800 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="whitespace-nowrap text-xs font-semibold text-zinc-400">ツール一覧(タグ絞り込み)</span>
          <input
            className="min-w-[8rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-[11px]"
            placeholder="名前・説明で検索…"
            value={toolSearch}
            onChange={(e) => setToolSearch(e.target.value)}
          />
          <span className="shrink-0 whitespace-nowrap text-[11px] text-zinc-500">{filteredTools.length}/{tools.length}件</span>
        </div>
        {exportMsg !== '' && <p className="text-[11px] text-zinc-400">{exportMsg}</p>}
        <div className="flex flex-wrap gap-1">
          <button
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              tagFilter === null ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
            onClick={() => setTagFilter(null)}
          >
            すべて
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                tagFilter === tag ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
            >
              {tag}
            </button>
          ))}
        </div>
        <ul className="max-h-48 space-y-1 overflow-auto text-xs">
          {filteredTools.length === 0 && <p className="text-zinc-500">該当なし</p>}
          {filteredTools.map((t) => (
            <li key={t.name} className="rounded border border-zinc-800 px-2 py-1">
              <div className="flex flex-wrap items-center gap-2">
                <button className="font-mono text-blue-300 hover:underline" onClick={() => setSelected(t.name)}>
                  {t.name}
                </button>
                <span className="text-[10px] text-zinc-500">({t.risk})</span>
                {/* M29-5: 仮導入(棚卸し未確定)マーク */}
                {t.provisional === true && (
                  <span className="shrink-0 rounded bg-emerald-900/60 px-1 text-[10px] text-emerald-300" title="仮導入(棚卸し未確定)。進化タブの棚卸しで残す/削除を確定できます">
                    仮
                  </span>
                )}
                {t.tags.map((tag) => (
                  <span key={tag} className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
                    {tag}
                  </span>
                ))}
                {/* M27-4: コード+テスト+マニフェストのディレクトリ書き出し(共有・レジストリ投稿用) */}
                <button
                  className="ml-auto rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
                  title="このプラグインをコード+テスト+マニフェストのフォルダとして書き出す"
                  onClick={() => {
                    void window.api
                      .pluginsExport(t.name)
                      .then((r) => setExportMsg(`${r.ok ? '✓' : '✗'} ${r.message}`))
                      .catch((err: unknown) =>
                        setExportMsg(`✗ ${err instanceof Error ? err.message : String(err)}`),
                      );
                  }}
                >
                  📦 エクスポート
                </button>
                {/* M91-2: レジストリへ公開(下見 → 全文承認 → fork+PR)。
                    その場で断っても、いつでもここから出せる */}
                <button
                  className="rounded border border-amber-800 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-950"
                  title="このツールをコミュニティレジストリへ公開する(送信前に全文を確認・承認します)"
                  onClick={() => publish.open(t.name)}
                >
                  ⛩ 公開
                </button>
              </div>
              <p className="mt-0.5 text-zinc-500">{t.description}</p>
            </li>
          ))}
        </ul>
        {publish.message !== '' && <p className="mt-1 text-[11px] text-zinc-400">{publish.message}</p>}
        {publish.plan !== null && (
          <PublishPluginDialog
            plan={publish.plan}
            busy={publish.busy}
            onSubmit={publish.submit}
            onCancel={publish.close}
          />
        )}
      </div>

      <div className="space-y-1 border-t border-zinc-800 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="whitespace-nowrap text-xs font-semibold text-zinc-400">チェックポイント(自動スナップショット)</span>
          <button
            className="shrink-0 whitespace-nowrap rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
            onClick={() => void loadCheckpoints()}
          >
            一覧を更新
          </button>
        </div>
        {ckptMsg && <p className="text-xs text-zinc-400">{ckptMsg}</p>}
        {checkpoints.length === 0 ? (
          <p className="text-xs text-zinc-500">
            (なし。git 管理下の workspace で write/exec ツールが成功すると自動作成される)
          </p>
        ) : (
          <ul className="max-h-40 space-y-1 overflow-auto text-xs">
            {checkpoints.map((c) => (
              <li key={c.sha} className="flex items-center gap-2">
                <code className="shrink-0 text-zinc-500">{c.sha.slice(0, 8)}</code>
                <span className="shrink-0 whitespace-nowrap text-zinc-400">
                  {new Date(c.createdAt).toLocaleString()}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-300">
                  {c.label}
                  <span className="text-zinc-500">({c.sessionId.slice(0, 8)})</span>
                </span>
                <button
                  className="rounded border border-amber-700 px-2 py-0.5 text-amber-400 hover:bg-amber-950"
                  onClick={() => void restoreCheckpoint(c.sha)}
                >
                  復元
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
