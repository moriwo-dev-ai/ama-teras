import { toDataURL } from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import type { RemoteStatusPayload } from '../../../../shared/types';
import { buildRemoteUrl, qrGuidance, resolveInitialHost } from './remoteUrl';
import { useT } from '../../i18n';

/** M13-0: 接続URLのQR表示。M21-3: 案内文とトークン再生成の導線は qrGuidance(純関数)で決定 */
function RemoteQr({
  url,
  tokenSet,
  hasPlainToken,
  onRegenerate,
}: {
  url: string;
  tokenSet: boolean;
  hasPlainToken: boolean;
  onRegenerate: () => void;
}): JSX.Element | null {
  const t = useT();
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
  const guide = qrGuidance(tokenSet, hasPlainToken);
  return (
    <div className="flex items-start gap-3">
      <img src={dataUrl} alt={t('remote.qrAlt')} className="h-40 w-40 rounded bg-white p-1" />
      <div className="max-w-[220px] space-y-2">
        <p className="text-[11px] text-zinc-400">{t(guide.messageKey)}</p>
        {guide.offerRegenerate && (
          <button
            className="rounded border border-blue-600 px-2 py-1 text-[11px] text-blue-300 hover:bg-blue-900/40"
            onClick={onRegenerate}
          >
            {t('remote.regenQr')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * M10-5: 設定パネルの「リモートアクセス(スマホ)」セクション。
 * トークン平文は生成/再生成の応答でのみ受け取り、この画面にだけ表示する(保存しない)。
 * ホスト名は Tailscale の MagicDNS 名等をユーザーが入力する(自動検出は初版では行わない)。
 */
export function RemoteAccessSection(): JSX.Element {
  const t = useT();
  const [status, setStatus] = useState<RemoteStatusPayload | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [port, setPort] = useState('8787');
  const [host, setHost] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmRegen, setConfirmRegen] = useState(false);
  const hostSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.api.remoteStatus().then((s) => {
      setStatus(s);
      setPort(String(s.port));
      // M32-8: config優先 → localStorage新キー(amateras-*)→ 旧キー、の順で解決。
      // localStorage経由で見つけた場合はconfigへ自己修復保存する
      const { host: initial, heal } = resolveInitialHost(s.host, (key) =>
        window.localStorage.getItem(key),
      );
      setHost(initial);
      if (heal) void window.api.remoteSetHost(initial);
    });
  }, []);

  const saveHost = (value: string): void => {
    setHost(value);
    // 1文字ごとのconfig書き込みを避ける(500msデバウンス)
    if (hostSaveTimer.current) clearTimeout(hostSaveTimer.current);
    hostSaveTimer.current = setTimeout(() => {
      window.api.remoteSetHost(value).catch(() => setNotice(t('remote.hostSaveFailed')));
    }, 500);
  };

  if (!status) return <p className='text-xs text-zinc-400'>{t('remote.loading')}</p>;

  const toggle = async (): Promise<void> => {
    setNotice('');
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setNotice(t('remote.portInvalid'));
      return;
    }
    try {
      const result = await window.api.remoteSetEnabled(!status.enabled, portNum);
      setStatus(result.status);
      if (result.token) {
        setToken(result.token);
        setNotice(t('remote.tokenIssued'));
      }
    } catch (err) {
      setNotice(t('remote.failed', { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  const regenerate = async (): Promise<void> => {
    setConfirmRegen(false);
    try {
      const result = await window.api.remoteRegenerateToken();
      setStatus(result.status);
      setToken(result.token);
      setNotice(t('remote.tokenRegenerated'));
    } catch (err) {
      setNotice(t('remote.failed', { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  const url = buildRemoteUrl(host, status.port, token);

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(() => setNotice(t('remote.copied', { label })));
  };

  return (
    <div className="space-y-2 rounded-md border border-zinc-700 p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-zinc-300">
          {t('remote.heading')}
        </label>
        <span
          className={`rounded px-2 py-0.5 text-[10px] ${
            status.running ? 'bg-green-900 text-green-300' : 'bg-zinc-700 text-zinc-400'
          }`}
        >
          {status.running ? t('remote.listening', { port: status.port }) : t('remote.stopped')}
        </span>
      </div>

      {status.lastError && (
        <p className="text-xs text-red-400">{t('remote.startFailed', { msg: status.lastError })}</p>
      )}

      <div className="flex items-center gap-2">
        <label className="text-xs text-zinc-400">{t('remote.port')}</label>
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
          {status.enabled ? t('remote.disable') : t('remote.enable')}
        </button>
        {status.tokenSet && (
          <button
            className="rounded bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
            onClick={() => setConfirmRegen(true)}
          >
            {t('remote.regenToken')}
          </button>
        )}
      </div>

      {status.enabled && (
        <div className="space-y-1">
          <label className="text-xs text-zinc-400">
            {t('remote.hostLabel')}
          </label>
          <input
            className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
            placeholder="mypc.tailxxxx.ts.net"
            value={host}
            onChange={(e) => saveHost(e.target.value)}
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
                onClick={() => copy(url, t('remote.urlLabel'))}
              >
                {t('remote.copy')}
              </button>
            </div>
          )}
          {url && (
            <RemoteQr
              url={url}
              tokenSet={status.tokenSet}
              hasPlainToken={token !== null}
              onRegenerate={() => setConfirmRegen(true)}
            />
          )}
          {/* M32-8: 黙って消さない — ホスト名が空でURL/QRを出せない理由を示す */}
          {!url && (
            <p className="text-[11px] text-zinc-500">
              {t('remote.hostHint')}
            </p>
          )}
        </div>
      )}

      {token && (
        <div className="space-y-1">
          <label className="text-xs text-amber-300">
            {t('remote.tokenLabel')}
          </label>
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="flex-1 rounded border border-amber-700 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-amber-200"
              value={token}
            />
            <button
              className="rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600"
              onClick={() => copy(token, t('remote.token'))}
            >
              {t('remote.copy')}
            </button>
          </div>
        </div>
      )}

      {status.tokenSet && !token && (
        <p className="text-[11px] text-zinc-500">
          {t('remote.tokenSetNote')}
        </p>
      )}

      {notice && <p className="text-xs text-zinc-400">{notice}</p>}

      {confirmRegen && (
        <div className="space-y-2 rounded border border-amber-700 bg-zinc-950 p-2">
          <p className="text-xs text-amber-300">
            {t('remote.regenConfirm')}
          </p>
          <div className="flex justify-end gap-2">
            <button
              className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
              onClick={() => setConfirmRegen(false)}
            >
              {t('remote.cancel')}
            </button>
            <button
              className="rounded bg-amber-600 px-3 py-1 text-xs hover:bg-amber-500"
              onClick={() => void regenerate()}
            >
              {t('remote.regenerate')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
