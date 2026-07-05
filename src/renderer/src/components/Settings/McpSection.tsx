import { useCallback, useEffect, useState } from 'react';
import type { McpConfig, McpServerStatus } from '../../../../shared/types';

const STATE_LABEL: Record<string, { text: string; cls: string }> = {
  connected: { text: '接続中', cls: 'bg-green-900 text-green-300' },
  connecting: { text: '接続中…', cls: 'bg-zinc-700 text-zinc-300' },
  error: { text: 'エラー', cls: 'bg-red-900 text-red-300' },
  disabled: { text: '無効', cls: 'bg-zinc-700 text-zinc-400' },
  untrusted: { text: '未信頼', cls: 'bg-amber-900 text-amber-300' },
};

/**
 * M13-2: MCPサーバー管理。追加時は必ず信頼確認を挟む(未信頼サーバーは接続されない)。
 * 設定の実体は userData/mcp.json(手編集も可。保存すると自動で再接続)。
 */
export function McpSection(): JSX.Element {
  const [statuses, setStatuses] = useState<McpServerStatus[] | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [notice, setNotice] = useState('');
  const [trustTarget, setTrustTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatuses(await window.api.mcpStatus());
    } catch (err) {
      setNotice(`状態取得失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentConfig = (): McpConfig => ({
    servers: Object.fromEntries((statuses ?? []).map((s) => [s.name, s.config])),
  });

  const save = async (config: McpConfig): Promise<void> => {
    setNotice('');
    try {
      setStatuses(await window.api.mcpSetConfig(config));
    } catch (err) {
      setNotice(`保存失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const add = (): void => {
    const n = name.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(n)) {
      setNotice('サーバー名は英数小文字とハイフン(32文字まで)');
      return;
    }
    if (command.trim() === '') {
      setNotice('コマンドを入力すること');
      return;
    }
    const config = currentConfig();
    if (config.servers[n]) {
      setNotice('同名のサーバーが既にある');
      return;
    }
    config.servers[n] = {
      command: command.trim(),
      args: args.trim() === '' ? [] : args.trim().split(/\s+/),
      enabled: true,
      trusted: false, // 信頼確認を通るまで接続しない
    };
    void save(config).then(() => setTrustTarget(n));
    setName('');
    setCommand('');
    setArgs('');
  };

  const setServer = (n: string, patch: Partial<McpConfig['servers'][string]>): void => {
    const config = currentConfig();
    const sc = config.servers[n];
    if (!sc) return;
    config.servers[n] = { ...sc, ...patch };
    void save(config);
  };

  const remove = (n: string): void => {
    const config = currentConfig();
    delete config.servers[n];
    void save(config);
  };

  if (!statuses) return <p className="text-xs text-zinc-400">MCP状態を読込中…</p>;

  return (
    <div className="space-y-2 rounded-md border border-zinc-700 p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-zinc-300">MCPサーバー(外部ツール連携)</label>
        <button
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          onClick={() => void refresh()}
        >
          状態更新
        </button>
      </div>

      {statuses.length === 0 && (
        <p className="text-[11px] text-zinc-500">
          未設定。stdio 起動型のMCPサーバーを追加すると、そのツールをチャットから使える
          (例: コマンド npx / 引数 -y @modelcontextprotocol/server-filesystem C:\dev)
        </p>
      )}

      <ul className="space-y-1">
        {statuses.map((s) => {
          const label = STATE_LABEL[s.state] ?? { text: s.state, cls: 'bg-zinc-700 text-zinc-300' };
          return (
            <li key={s.name} className="rounded border border-zinc-800 px-2 py-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-zinc-200">{s.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${label.cls}`}>{label.text}</span>
                {s.state === 'connected' && <span className="text-zinc-500">ツール{s.toolCount}件</span>}
                <div className="ml-auto flex gap-1">
                  {s.state === 'untrusted' && (
                    <button
                      className="rounded bg-amber-700 px-2 py-0.5 text-[10px] hover:bg-amber-600"
                      onClick={() => setTrustTarget(s.name)}
                    >
                      信頼して接続
                    </button>
                  )}
                  <button
                    className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
                    onClick={() => setServer(s.name, { enabled: s.config.enabled === false })}
                  >
                    {s.config.enabled === false ? '有効化' : '無効化'}
                  </button>
                  <button
                    className="rounded border border-red-900 px-2 py-0.5 text-[10px] text-red-400 hover:bg-zinc-800"
                    onClick={() => remove(s.name)}
                  >
                    削除
                  </button>
                </div>
              </div>
              <p className="truncate font-mono text-[10px] text-zinc-500">
                {s.config.command} {(s.config.args ?? []).join(' ')}
              </p>
              {s.error && <p className="text-[10px] text-red-400">{s.error}</p>}
            </li>
          );
        })}
      </ul>

      <div className="space-y-1 border-t border-zinc-800 pt-2">
        <div className="flex gap-1">
          <input
            className="w-28 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
            placeholder="名前(例: fs)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="w-24 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
            placeholder="コマンド"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
            placeholder="引数(空白区切り)"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
          <button className="rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500" onClick={add}>
            追加
          </button>
        </div>
      </div>

      {notice && <p className="text-xs text-zinc-400">{notice}</p>}

      {trustTarget && (
        <div className="space-y-2 rounded border border-amber-700 bg-zinc-950 p-2">
          <p className="text-xs text-amber-300">
            MCPサーバー「{trustTarget}」のツールを許可する?
            外部プロセスが起動し、そのツールはパスベースのスコープ判定の対象外になる
            (書き込み・実行系は引き続き承認ダイアログが出る)。
          </p>
          <div className="flex justify-end gap-2">
            <button
              className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
              onClick={() => setTrustTarget(null)}
            >
              許可しない
            </button>
            <button
              className="rounded bg-amber-600 px-3 py-1 text-xs hover:bg-amber-500"
              onClick={() => {
                setServer(trustTarget, { trusted: true });
                setTrustTarget(null);
              }}
            >
              信頼して接続
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
