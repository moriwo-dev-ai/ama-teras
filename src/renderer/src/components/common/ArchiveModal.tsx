import { useState } from 'react';

/**
 * M97: 「完了済み」の格納庫。右ペイン(進化ジョブ・運営の下書き)は終わったものが
 * 積み上がって現役の項目が埋もれていた。終わったものは1行の折りたたみに畳み、
 * 見たいときだけ全画面モーダルで一覧する。
 *
 * 中身の描画は呼び出し側に任せる(ジョブと下書きで見せ方が違うため)。
 * ここが持つのは「畳む・開く・数える・閉じる」だけ。
 */
export function ArchiveModal({
  title,
  count,
  onClose,
  children,
}: {
  title: string;
  count: number;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="anim-pop flex max-h-[85vh] w-[720px] max-w-[92vw] flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-700 px-3 py-2">
          <h3 className="text-sm font-semibold text-zinc-100">
            {title} <span className="text-xs font-normal text-zinc-500">({count}件)</span>
          </h3>
          <button
            className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            onClick={onClose}
          >
            閉じる
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  );
}

/**
 * 「完了済み(N件)」の1行トグル。押すとモーダルを開く。
 * 0件のときは何も描かない(空の行で場所を取らない)
 */
export function ArchiveToggle({
  label,
  count,
  onOpen,
}: {
  label: string;
  count: number;
  onOpen: () => void;
}): JSX.Element | null {
  if (count === 0) return null;
  return (
    <button
      className="w-full rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-left text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
      onClick={onOpen}
    >
      📁 {label}({count}件)— クリックで一覧
    </button>
  );
}

/** モーダルの開閉状態を持つだけの小さなフック(呼び出し側の useState を1行に畳む) */
export function useArchive(): { open: boolean; show: () => void; hide: () => void } {
  const [open, setOpen] = useState(false);
  return { open, show: () => setOpen(true), hide: () => setOpen(false) };
}
