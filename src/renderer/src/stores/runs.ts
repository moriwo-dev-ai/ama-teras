import { create } from 'zustand';
import type { RunInfo } from '../../../shared/types';

/** M22: 実行中ラン一覧(複数プロジェクト同時実行)。左ペインの実行中表示・イベント帰属判定に使う */
interface RunsState {
  runs: RunInfo[];
  setRuns: (runs: RunInfo[]) => void;
  refresh: () => Promise<void>;
}

export const useRunsStore = create<RunsState>((set) => ({
  runs: [],
  setRuns: (runs) => set({ runs }),
  refresh: async () => {
    try {
      set({ runs: await window.api.runsList() });
    } catch {
      /* 取得失敗は次の runs:changed で回復 */
    }
  },
}));

