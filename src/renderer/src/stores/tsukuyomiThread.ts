import { create } from 'zustand';
import type { TalkEntry } from '../../../shared/types';

/**
 * M43-2(TUKU-yomi): 左ペイン常設の「🌙 TUKU-yomi」。
 * open=true のときメイン領域に TsukuyomiThreadPanel を出す(⛩運営と同じ流儀。通常チャットと混ぜない)。
 */
interface TsukuyomiThreadState {
  open: boolean;
  talks: TalkEntry[];
  setOpen: (open: boolean) => void;
  refreshTalks: () => Promise<void>;
  clear: () => Promise<void>;
}

export const useTsukuyomiThreadStore = create<TsukuyomiThreadState>((set, get) => ({
  open: false,
  talks: [],
  setOpen: (open) => {
    set({ open });
    if (open) void get().refreshTalks();
  },
  refreshTalks: async () => {
    try {
      set({ talks: await window.api.tsukuyomiTalks() });
    } catch {
      set({ talks: [] });
    }
  },
  clear: async () => {
    await window.api.tsukuyomiTalkClear();
    await get().refreshTalks();
  },
}));
