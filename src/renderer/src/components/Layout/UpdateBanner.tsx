import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../../../../shared/types';

const DISMISS_KEY = 'amateras-update-dismissed';

/**
 * M42-1: 新しい版が出ていることを知らせるだけのバナー。
 * ここでダウンロードも書き換えもしない(本体を勝手に入れ替えるのは思想に反する)。
 * 同じ版を閉じたら二度と出さない(localStorage にその版だけを記録する)
 */
export function UpdateBanner(): JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string>(() => localStorage.getItem(DISMISS_KEY) ?? '');

  useEffect(() => {
    // 起動直後はAPIキー確認やセッション復元で忙しいので少し待つ
    const t = setTimeout(() => {
      window.api
        .updateCheck()
        .then((r) => setInfo(r))
        .catch(() => {});
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  if (info === null || !info.newer || dismissed === info.latest) return null;

  return (
    <div className="flex items-center justify-center gap-3 border-b border-sky-800 bg-sky-950/70 px-4 py-1 text-xs text-sky-200">
      <span>
        ✨ 新しい版があります: <strong>{info.latest}</strong>(いま {info.current})— {info.name}
      </span>
      {info.url !== '' && (
        <button
          className="rounded border border-sky-700 px-2 py-0.5 text-sky-100 hover:bg-sky-900"
          onClick={() => {
            void window.api.openExternal(info.url);
          }}
        >
          リリースノートを見る
        </button>
      )}
      <button
        className="text-sky-300 hover:text-sky-100"
        title="この版の通知を閉じる"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, info.latest);
          setDismissed(info.latest);
        }}
      >
        ✕
      </button>
    </div>
  );
}
