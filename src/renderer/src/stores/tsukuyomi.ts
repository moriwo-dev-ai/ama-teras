import { create } from 'zustand';
import type { ChoEntry, TsukuyomiStatus } from '../../../shared/types';

/**
 * M42(TUKU-yomi): 月読モードの renderer 状態。
 * 鍵の無い機体では main が enabled:false を返すので、タブもトグルも自然に消える。
 */
interface TsukuyomiState {
  status: TsukuyomiStatus | null;
  entries: ChoEntry[];
  refresh: () => Promise<void>;
  refreshEntries: () => Promise<void>;
}

export const useTsukuyomiStore = create<TsukuyomiState>((set) => ({
  status: null,
  entries: [],
  refresh: async () => {
    const [status, entries] = await Promise.all([
      window.api.tsukuyomiStatus(),
      window.api.tsukuyomiList(),
    ]);
    set({ status, entries });
  },
  refreshEntries: async () => {
    set({ entries: await window.api.tsukuyomiList() });
  },
}));
