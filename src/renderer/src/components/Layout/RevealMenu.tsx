import { useEffect } from 'react';
import { useRevealMenuStore } from '../../stores/revealMenu';

/** 整理1: パス右クリックの「フォルダで開く」メニュー本体。App直下に1個だけ置く */
export function RevealMenu(): JSX.Element | null {
  const target = useRevealMenuStore((s) => s.target);
  const close = useRevealMenuStore((s) => s.close);

  useEffect(() => {
    if (!target) return;
    const onDismiss = (): void => close();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', onDismiss);
    window.addEventListener('contextmenu', onDismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onDismiss);
      window.removeEventListener('contextmenu', onDismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [target, close]);

  if (!target) return null;
  return (
    <div
      className="fixed z-50 rounded border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
      style={{ left: target.x, top: target.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="block w-full px-3 py-1 text-left hover:bg-zinc-800"
        title={target.path}
        onClick={() => {
          void window.api.fileReveal(target.path);
          close();
        }}
      >
        📂 フォルダで開く
      </button>
    </div>
  );
}
