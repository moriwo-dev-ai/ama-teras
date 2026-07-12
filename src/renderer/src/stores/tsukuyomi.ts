import { create } from 'zustand';
import type { ChoEntry, TsukuyomiStatus } from '../../../shared/types';

/**
 * M42(TUKU-yomi): 月読モードの renderer 状態。
 * 鍵の無い機体では main が enabled:false を返すので、タブもトグルも自然に消える。
 */

/** M42-5: 抽出された候補(**帳にはまだ入っていない**。人が承認したときだけ入る) */
export interface ChoCandidate {
  kind: ChoEntry['kind'];
  text: string;
  due?: string;
}

interface TsukuyomiState {
  status: TsukuyomiStatus | null;
  entries: ChoEntry[];
  /** 常時聴取が拾った確認待ち。勝手に帳へ書かない(岩戸の思想) */
  pending: ChoCandidate[];
  /**
   * 押して話す(PTT)の最中か。この間は常時聴取を黙らせる —
   * 同じ声を2経路で拾うと1回の発話から候補が2つできる(実機で起きた)
   */
  pushToTalk: boolean;
  setPushToTalk: (active: boolean) => void;
  refresh: () => Promise<void>;
  refreshEntries: () => Promise<void>;
  addPending: (items: ChoCandidate[]) => void;
  removePending: (index: number) => void;
}

export const useTsukuyomiStore = create<TsukuyomiState>((set) => ({
  status: null,
  entries: [],
  pending: [],
  pushToTalk: false,
  setPushToTalk: (active) => set({ pushToTalk: active }),
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
  addPending: (items) => set((s) => ({ pending: [...s.pending, ...items] })),
  removePending: (index) => set((s) => ({ pending: s.pending.filter((_, i) => i !== index) })),
}));
