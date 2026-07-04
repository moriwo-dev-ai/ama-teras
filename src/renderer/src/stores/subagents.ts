import { create } from 'zustand';
import type { SubAgentUpdate } from '../../../shared/types';

/** M12-3: 並列サブエージェントの進行状況(エージェントパネル用) */
interface SubAgentState {
  /** 子ID → 最新の進行状況 */
  agents: SubAgentUpdate[];
  handleUpdate: (u: SubAgentUpdate) => void;
  clear: () => void;
}

export const useSubAgentStore = create<SubAgentState>((set) => ({
  agents: [],
  handleUpdate: (u) =>
    set((s) => {
      const rest = s.agents.filter((a) => a.id !== u.id);
      // running 中の currentTool 更新は task/mode を引き継ぐ
      const prev = s.agents.find((a) => a.id === u.id);
      const merged: SubAgentUpdate = { ...prev, ...u };
      return { agents: [...rest, merged].sort((a, b) => b.id - a.id) };
    }),
  clear: () => set({ agents: [] }),
}));
