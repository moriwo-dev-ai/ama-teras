import type { MouseEvent } from 'react';
import { create } from 'zustand';

/** 整理1: パス右クリック「フォルダで開く」メニュー(アプリに1個だけマウント) */
interface RevealMenuState {
  target: { path: string; x: number; y: number } | null;
  open: (path: string, x: number, y: number) => void;
  close: () => void;
}

export const useRevealMenuStore = create<RevealMenuState>((set) => ({
  target: null,
  open: (path, x, y) => set({ target: { path, x, y } }),
  close: () => set({ target: null }),
}));

/** パス表示要素に付ける共通ハンドラ(既定メニュー抑止+外側のclick/contextmenuへ伝播させない) */
export function revealContextMenuHandler(path: string) {
  return (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    useRevealMenuStore.getState().open(path, e.clientX, e.clientY);
  };
}
