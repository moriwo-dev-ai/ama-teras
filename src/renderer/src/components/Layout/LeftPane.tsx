import { useEffect, useMemo, useRef, useState } from 'react';
import { groupSessionsByProject } from '../../../../shared/sessionGroups';
import type { SessionMeta } from '../../../../shared/types';
import { useChatStore } from '../../stores/chat';

/**
 * M15-2: 左ペイン — プロジェクト(=workspace)ごとのセッションツリー。
 * - クリックで切替(workspace が違えば自動で追従。実行中は不可)
 * - 検索はタイトル+本文の部分一致(sessions:search)
 * - 右クリック: 名前変更 / 削除
 */

function projectName(ws: string): string {
  const parts = ws.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? ws;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

export function LeftPane(): JSX.Element {
  const { sessions, refreshSessions, loadSession, newSession, activeSessionId } = useChatStore();
  const busy = activeSessionId !== null;
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SessionMeta[] | null>(null);
  const [currentWs, setCurrentWs] = useState('');
  const [menu, setMenu] = useState<
    { kind: 'session'; id: string; x: number; y: number } | { kind: 'project'; ws: string; x: number; y: number } | null
  >(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [notice, setNotice] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshWs = async (): Promise<void> => {
    try {
      const cfg = await window.api.settingsGet();
      setCurrentWs(cfg.workspace ?? '');
    } catch {
      /* 表示のみの情報 */
    }
  };

  useEffect(() => {
    void refreshSessions();
    void refreshWs();
  }, [refreshSessions]);
  useEffect(() => {
    if (!busy) {
      void refreshSessions();
      void refreshWs();
    }
  }, [busy, refreshSessions]);

  // 検索(300msデバウンス)
  useEffect(() => {
    if (query.trim() === '') {
      setSearchResults(null);
      return;
    }
    const t = setTimeout(() => {
      window.api
        .sessionsSearch(query)
        .then(setSearchResults)
        .catch(() => setSearchResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const shown = searchResults ?? sessions;
  // M17-3: 並びは「配下セッションの最新更新の降順」に固定。選択(閲覧)では動かさない。
  // 現在のプロジェクトはハイライト(「現在」バッジ)でのみ示す
  const groups = useMemo(() => groupSessionsByProject(shown), [shown]);

  const open = async (meta: SessionMeta): Promise<void> => {
    if (busy) return;
    setNotice('');
    try {
      // M15-2: workspace が異なるセッションは workspace も自動で切替(M12の制約解消)
      if (meta.workspace && meta.workspace !== currentWs) {
        const cfg = await window.api.settingsGet();
        await window.api.settingsSet({ ...cfg, workspace: meta.workspace });
        setCurrentWs(meta.workspace);
      }
      await loadSession(meta.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const addProject = async (): Promise<void> => {
    if (busy) return;
    const picked = await window.api.pickWorkspace();
    if (!picked) return;
    const cfg = await window.api.settingsGet();
    await window.api.settingsSet({ ...cfg, workspace: picked });
    setCurrentWs(picked);
    await newSession();
  };

  const doRename = async (): Promise<void> => {
    if (!renaming) return;
    const ok = await window.api.sessionsRename(renaming.id, renaming.title);
    if (!ok) setNotice('名前を変更できない');
    setRenaming(null);
    await refreshSessions();
    if (searchResults) setSearchResults(await window.api.sessionsSearch(query));
  };

  const doDelete = async (id: string): Promise<void> => {
    setMenu(null);
    await window.api.sessionsDelete(id);
    await refreshSessions();
    if (searchResults) setSearchResults(await window.api.sessionsSearch(query));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onClick={() => setMenu(null)}>
      <div className="space-y-2 border-b border-zinc-800 p-2">
        <button
          className="w-full rounded bg-blue-600 px-2 py-1.5 text-xs hover:bg-blue-500 disabled:opacity-40"
          disabled={busy}
          onClick={() => void newSession()}
        >
          + 新規チャット
        </button>
        <input
          ref={searchRef}
          id="session-search"
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
          placeholder="検索(タイトル・本文)… Ctrl+K"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-1 text-xs">
        {groups.length === 0 && (
          <p className="p-2 text-zinc-500">{query ? '該当なし' : 'セッションはまだ無い'}</p>
        )}
        {groups.map(([ws, items]) => (
          <div key={ws} className="mb-2">
            <div
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-zinc-400"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: 'project', ws, x: e.clientX, y: e.clientY });
              }}
            >
              {/* M17-3: 選択中プロジェクトはハイライトのみ(並びは動かさない) */}
              <span className={`truncate ${ws === currentWs ? 'text-blue-300' : ''}`} title={ws}>
                📁 {projectName(ws)}
              </span>
              {ws === currentWs && <span className="rounded bg-blue-900 px-1 text-[9px] text-blue-300">現在</span>}
              {ws === currentWs && (
                <button
                  className="ml-auto rounded border border-zinc-700 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800"
                  title="別フォルダで新規プロジェクト"
                  onClick={(e) => {
                    e.stopPropagation();
                    void addProject();
                  }}
                >
                  +
                </button>
              )}
            </div>
            {/* プロジェクトの一段下にツリー表示(縦線+インデント) */}
            <ul className="ml-3 border-l border-zinc-800 pl-1.5">
              {items.map((s) => (
                <li key={s.id}>
                  {renaming?.id === s.id ? (
                    <input
                      autoFocus
                      className="w-full rounded border border-blue-600 bg-zinc-900 px-2 py-1 text-xs"
                      value={renaming.title}
                      onChange={(e) => setRenaming({ id: s.id, title: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void doRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => void doRename()}
                    />
                  ) : (
                    <button
                      className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                      disabled={busy}
                      title={`${s.title}(${new Date(s.updatedAt).toLocaleString()})`}
                      onClick={() => void open(s)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ kind: 'session', id: s.id, x: e.clientX, y: e.clientY });
                      }}
                    >
                      {/* タイトルだけを truncate し、更新時刻は右端に固定(ペイン幅を変えても見える) */}
                      <span className="min-w-0 flex-1 truncate">{s.title || '(無題)'}</span>
                      <span className="shrink-0 whitespace-nowrap text-[10px] text-zinc-500">
                        {relTime(s.updatedAt)}
                      </span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {notice && <p className="border-t border-zinc-800 p-2 text-[11px] text-red-400">{notice}</p>}

      {menu && (
        <div
          className="fixed z-50 rounded border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === 'session' ? (
            <>
              <button
                className="block w-full px-3 py-1 text-left hover:bg-zinc-800"
                onClick={() => {
                  const target = shown.find((s) => s.id === menu.id);
                  setRenaming({ id: menu.id, title: target?.title ?? '' });
                  setMenu(null);
                }}
              >
                名前変更
              </button>
              <button
                className="block w-full px-3 py-1 text-left text-red-400 hover:bg-zinc-800"
                onClick={() => void doDelete(menu.id)}
              >
                削除
              </button>
            </>
          ) : (
            <button
              className="block w-full px-3 py-1 text-left hover:bg-zinc-800"
              title={menu.ws}
              onClick={() => {
                void window.api.fileReveal(menu.ws);
                setMenu(null);
              }}
            >
              📂 フォルダで開く
            </button>
          )}
        </div>
      )}
    </div>
  );
}
