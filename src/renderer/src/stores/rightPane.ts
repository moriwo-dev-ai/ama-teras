import { create } from 'zustand';

/** M15-4: 右ペインのタブ状態(ヘッダボタン・プレビュー・バッジで共有) */
export type RightPaneTab = 'preview' | 'plan' | 'agents' | 'evolution' | 'debug';

interface RightPaneState {
  tab: RightPaneTab;
  /** ヘッダボタン等からの「右ペインを開いてこのタブへ」要求(Appが購読して折りたたみ解除) */
  openRequestCount: number;
  setTab: (tab: RightPaneTab) => void;
  openTab: (tab: RightPaneTab) => void;
}

export const useRightPaneStore = create<RightPaneState>((set) => ({
  tab: 'preview',
  openRequestCount: 0,
  setTab: (tab) => set({ tab }),
  openTab: (tab) => set((s) => ({ tab, openRequestCount: s.openRequestCount + 1 })),
}));
