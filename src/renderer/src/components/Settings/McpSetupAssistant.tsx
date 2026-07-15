import { useCallback, useEffect, useState } from 'react';
import type {
  McpCatalogEntry,
  McpProbeResult,
  McpReadiness,
  McpServerConfig,
} from '../../../../shared/types';

/**
 * M93: MCPセットアップ助手。既知サーバーのカタログから「テンプレを埋めて→前提を点検して→
 * 接続を試す」までを助ける。追加は必ず未信頼(trusted:false)で行い、実際に繋ぐ判断
 * (信頼)・APIキー・ホストアプリ導入は人間が握る=助手は肩代わりしない。
 */

interface CatalogItem {
  entry: McpCatalogEntry;
  readiness: McpReadiness;
}

const CATEGORY_LABEL: Record<McpCatalogEntry['category'], string> = {
  files: 'ファイル',
  visual: '映像・3D',
  data: 'データ',
  web: 'Web',
  memory: '記憶',
  other: 'その他',
};

/** args テンプレの {{token}} を values で埋める(未指定はそのまま=未完成の印) */
function fillArgs(args: readonly string[], values: Record<string, string>): string[] {
  return args.map((a) => {
    const m = /^\{\{([a-z0-9_]+)\}\}$/.exec(a);
    if (!m) return a;
    const v = values[m[1] as string];
    return v !== undefined && v.trim() !== '' ? v.trim() : a;
  });
}

function stillHasPlaceholder(args: readonly string[]): boolean {
  return args.some((a) => /^\{\{[a-z0-9_]+\}\}$/.test(a));
}

interface Props {
  existingNames: string[];
  onAdd: (name: string, sc: McpServerConfig) => void;
}

export function McpSetupAssistant({ existingNames, onAdd }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [probes, setProbes] = useState<Record<string, { loading?: boolean; result?: McpProbeResult }>>({});

  const load = useCallback(async () => {
    try {
      setCatalog(await window.api.mcpCatalog());
    } catch (err) {
      setLoadError(`カタログ取得失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    if (open && catalog === null) void load();
  }, [open, catalog, load]);

  const setVal = (id: string, token: string, v: string): void =>
    setValues((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [token]: v } }));

  const configFor = (entry: McpCatalogEntry): McpServerConfig => ({
    command: entry.command,
    args: fillArgs(entry.args, values[entry.id] ?? {}),
    enabled: true,
    trusted: false,
  });

  const probe = async (entry: McpCatalogEntry): Promise<void> => {
    setProbes((p) => ({ ...p, [entry.id]: { loading: true } }));
    try {
      const result = await window.api.mcpProbe(configFor(entry));
      setProbes((p) => ({ ...p, [entry.id]: { result } }));
    } catch (err) {
      setProbes((p) => ({
        ...p,
        [entry.id]: { result: { ok: false, toolCount: 0, toolNames: [], error: err instanceof Error ? err.message : String(err) } },
      }));
    }
  };

  const add = (entry: CatalogItem['entry']): void => {
    let name = entry.suggestedName;
    // 名前衝突は連番で回避(fs → fs2 → fs3…)
    for (let i = 2; existingNames.includes(name); i++) name = `${entry.suggestedName}${i}`;
    onAdd(name, configFor(entry));
  };

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-2">
      <button
        className="flex w-full items-center gap-2 text-left text-xs font-semibold text-zinc-300 hover:text-zinc-100"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>🧩 セットアップ助手(既知サーバーから選ぶ)</span>
      </button>

      {open && (
        <div className="space-y-2">
          {loadError && <p className="text-[11px] text-red-400">{loadError}</p>}
          {catalog === null && !loadError && <p className="text-[11px] text-zinc-500">カタログ読込中…</p>}

          {(catalog ?? []).map(({ entry, readiness }) => {
            const vals = values[entry.id] ?? {};
            const filled = fillArgs(entry.args, vals);
            const incomplete = stillHasPlaceholder(filled);
            const pr = probes[entry.id];
            return (
              <div key={entry.id} className="space-y-1 rounded border border-zinc-800 bg-zinc-950 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-zinc-200">{entry.title}</span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {CATEGORY_LABEL[entry.category]}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      entry.cost === 'free' ? 'bg-green-900 text-green-300' : 'bg-amber-900 text-amber-300'
                    }`}
                  >
                    {entry.cost === 'free' ? '無料' : '有料(鍵が要る)'}
                  </span>
                  {readiness.ready ? (
                    <span className="rounded bg-green-900 px-1.5 py-0.5 text-[10px] text-green-300">準備OK</span>
                  ) : (
                    <span className="rounded bg-red-900 px-1.5 py-0.5 text-[10px] text-red-300">前提が不足</span>
                  )}
                </div>
                <p className="text-[11px] text-zinc-400">{entry.description}</p>

                {/* 前提チェックリスト */}
                <ul className="space-y-0.5">
                  {readiness.items.map((it, i) => (
                    <li key={i} className="flex items-start gap-1 text-[10px]">
                      <span className={it.ok === true ? 'text-green-400' : it.ok === false ? 'text-red-400' : 'text-amber-400'}>
                        {it.ok === true ? '✓' : it.ok === false ? '✗' : '•'}
                      </span>
                      <span className="text-zinc-400">
                        {it.name ? <span className="font-mono text-zinc-300">{it.name}</span> : null}
                        {it.name ? ' — ' : ''}
                        {it.hint}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* プレースホルダ入力 */}
                {(entry.placeholders ?? []).map((ph) => (
                  <div key={ph.token} className="flex items-center gap-1">
                    <span className="w-14 shrink-0 font-mono text-[10px] text-zinc-500">{ph.token}</span>
                    <input
                      className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-[11px]"
                      placeholder={ph.hint}
                      value={vals[ph.token] ?? ph.default ?? ''}
                      onChange={(e) => setVal(entry.id, ph.token, e.target.value)}
                    />
                  </div>
                ))}

                <p className="truncate font-mono text-[10px] text-zinc-600">
                  {entry.command} {filled.join(' ')}
                </p>

                {/* 接続テスト結果 */}
                {pr?.loading && <p className="text-[10px] text-zinc-500">接続テスト中…</p>}
                {pr?.result && (
                  <p className={`text-[10px] ${pr.result.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {pr.result.ok
                      ? `✓ 接続OK(ツール${pr.result.toolCount}件: ${pr.result.toolNames.slice(0, 6).join(', ')}${pr.result.toolNames.length > 6 ? '…' : ''})`
                      : `✗ 接続失敗: ${pr.result.error ?? '不明なエラー'}`}
                  </p>
                )}

                <div className="flex items-center gap-1 pt-0.5">
                  <button
                    className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                    disabled={incomplete || pr?.loading === true}
                    title={incomplete ? '未入力の項目がある' : '設定を保存せず1回だけ繋いで確かめる'}
                    onClick={() => void probe(entry)}
                  >
                    接続テスト
                  </button>
                  <button
                    className="rounded bg-blue-600 px-2 py-0.5 text-[10px] hover:bg-blue-500 disabled:opacity-40"
                    disabled={incomplete}
                    title="未信頼で設定に追加(この後リストで「信頼して接続」を押すと繋がる)"
                    onClick={() => add(entry)}
                  >
                    設定に追加(未信頼)
                  </button>
                  {entry.homepage && (
                    <a
                      className="ml-auto text-[10px] text-zinc-500 underline hover:text-zinc-300"
                      href={entry.homepage}
                      target="_blank"
                      rel="noreferrer"
                    >
                      詳細
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-zinc-600">
            助手が肩代わりするのは「調べる・埋める・試す」まで。信頼・APIキー・ホストアプリ導入は人間が握る。
          </p>
        </div>
      )}
    </div>
  );
}
