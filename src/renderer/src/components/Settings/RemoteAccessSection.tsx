import { toDataURL } from 'qrcode';
import { useEffect, useState } from 'react';
import type { RemoteStatusPayload } from '../../../../shared/types';
import { buildRemoteUrl } from './remoteUrl';

const HOST_KEY = 'mycodex-remote-host';

/** M13-0: 接続URLのQR表示。スマホカメラで読むだけで接続できるようにする */
function RemoteQr({ url, withToken }: { url: string; withToken: boolean }): JSX.Element | null {
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    let alive = true;
    toDataURL(url, { width: 192, margin: 1 })
      .then((d) => {
        if (alive) setDataUrl(d);
      })
      .catch(() => {
        if (alive) setDataUrl('');
      });
    return () => {
      alive = false;
    };
  }, [url]);

  if (!dataUrl) return null;
  return (
    <div className="flex items-start gap-3">
      <img src={dataUrl} alt="接続QRコード" className="h-40 w-40 rounded bg-white p-1" />
      <p className="max-w-[220px] text-[11px] text-zinc-400">
        {withToken
          ? 'トークン込みの接続QR。スマホのカメラで読むだけで接続できる(この画面にいる間だけ表示)'
          : 'トークン無しのURL(接続にはトークン入力が必要)。トークン込みQRは有効化直後かトークン再生成直後にのみ表示される'}
      </p>
    </div>
  );
}

/**
 * M10-5: 設定パネルの「リモートアクセス(スマホ)」セクション。
 * トークン平文は生成/再生成の応答でのみ受け取り、この画面にだけ表示する(保存しない)。
 * ホスト名は Tailscale の MagicDNS 名等をユーザーが入力する(自動検出は初版では行わない)。
 */
export function RemoteAccessSection(): JSX.Element {
  const [status, setStatus] = useState<RemoteStatusPayload | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [port, setPort] = useState('8787');
  const [host, setHost] = useState(() => window.localStorage.getItem(HOST_KEY) ?? '');
  const [notice, setNotice] = useState('');
  const [confirmRegen, setConfirmRegen] = useState(false);

  useEffect(() => {
    void window.api.remoteStatus().then((s) => {
      setStatus(s);
      setPort(String(s.port));
    });
  }, []);

  if (!status) return <p className="text-xs text-zinc-400">リモート状態を読込中…</p>;

  const toggle = async (): Promise<void> => {
    setNotice('');
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setNotice('ポート番号が不正(1〜65535)');
      return;
    }
    try {
      const result = await window.api.remoteSetEnabled(!status.enabled, portNum);
      setStatus(result.status);
      if (result.token) {
        setToken(result.token);
        setNotice('トークンを発行した。この画面にしか表示されないので今すぐスマホに設定を。');
      }
    } catch (err) {
      setNotice(`失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const regenerate = async (): Promise<void> => {
    setConfirmRegen(false);
    try {
      const result = await window.api.remoteRegenerateToken();
      setStatus(result.status);
      setToken(result.token);
      setNotice('トークンを再生成した(旧トークンは即失効)。');
    } catch (err) {
      setNotice(`失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const url = buildRemoteUrl(host, status.port, token);

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(() => setNotice(`${label}をコピーした`));
  };

  return (
    <div className="space-y-2 rounded-md border border-zinc-700 p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-zinc-300">
          リモートアクセス(スマホ・Tailscale経由)
        </label>
        <span
          className={`rounded px-2 py-0.5 text-[10px] ${
            status.running ? 'bg-green-900 text-green-300' : 'bg-zinc-700 text-zinc-400'
          }`}
        >
          {status.running ? `待受中 :${status.port}` : '停止中'}
        </span>
      </div>

      {status.lastError && (
        <p className="text-xs text-red-400">起動失敗: {status.lastError}(ポート競合など)</p>
      )}

      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400">ポート</label>
        <input
          className="w-20 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
          value={port}
          disabled={status.enabled}
          onChange={(e) => setPort(e.target.value)}
        />
        <button
          className={`rounded px-3 py-1 text-xs ${
            status.enabled ? 'bg-red-700 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-500'
          }`}
          onClick={() => void toggle()}
        >
          {status.enabled ? '無効にする' : '有効にする'}
        </button>
        {status.tokenSet && (
          <button
            className="rounded bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
            onClick={() => setConfirmRegen(true)}
          >
            トークン再生成
          </button>
        )}
      </div>

      {status.enabled && (
        <div className="space-y-1">
          <label className="text-xs text-zinc-400">
            接続ホスト名(Tailscale の MagicDNS 名。例: mypc.tailxxxx.ts.net)
          </label>
          <input
            className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
            placeholder="mypc.tailxxxx.ts.net"
            value={host}
            onChange={(e) => {
              setHost(e.target.value);
              window.localStorage.setItem(HOST_KEY, e.target.value);
            }}
          />
          {url && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                className="flex-1 rounded border border-zinc-600 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-300"
                value={url}
              />
              <button
                className="rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600"
                onClick={() => copy(url, '接続URL')}
              >
                コピー
              </button>
            </div>
          )}
          {url && <RemoteQr url={url} withToken={token !== null} />}
        </div>
      )}

      {token && (
        <div className="space-y-1">
          <label className="text-xs text-amber-300">
            ペアリングトークン(この画面にのみ表示。保存されない)
          </label>
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="flex-1 rounded border border-amber-700 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-amber-200"
              value={token}
            />
            <button
              className="rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600"
              onClick={() => copy(token, 'トークン')}
            >
              コピー
            </button>
          </div>
        </div>
      )}

      {status.tokenSet && !token && (
        <p className="text-[11px] text-zinc-500">
          トークンは発行済み(平文は保存していないため再表示できない。忘れた場合は再生成)
        </p>
      )}

      {notice && <p className="text-xs text-zinc-400">{notice}</p>}

      {confirmRegen && (
        <div className="space-y-2 rounded border border-amber-700 bg-zinc-950 p-2">
          <p className="text-xs text-amber-300">
            トークンを再生成すると、接続済みのスマホは全て再設定が必要になる。続ける?
          </p>
          <div className="flex justify-end gap-2">
            <button
              className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
              onClick={() => setConfirmRegen(false)}
            >
              キャンセル
            </button>
            <button
              className="rounded bg-amber-600 px-3 py-1 text-xs hover:bg-amber-500"
              onClick={() => void regenerate()}
            >
              再生成する
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
