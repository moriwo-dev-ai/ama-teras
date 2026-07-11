import { create } from 'zustand';

/**
 * M33-4: ⛩ 運営スレッド(左ペイン常設)の開閉と未処理バッジ。
 * open=true のときメイン領域に OpsThreadPanel を表示する(通常チャットと混ぜない)。
 */
interface OpsThreadState {
  open: boolean;
  pending: number;
  setOpen: (open: boolean) => void;
  refreshPending: () => Promise<void>;
}

export const useOpsThreadStore = create<OpsThreadState>((set) => ({
  open: false,
  pending: 0,
  setOpen: (open) => set({ open }),
  refreshPending: async () => {
    try {
      set({ pending: await window.api.operationsThreadPending() });
    } catch {
      set({ pending: 0 });
    }
  },
}));
