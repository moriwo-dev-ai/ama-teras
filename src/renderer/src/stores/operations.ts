import { create } from 'zustand';
import type { AdapterStatusInfo } from '../../../shared/types';

/**
 * M32-1: 運営(Project TAKAMA-gahara)の有効状態。
 * オーナーモード(operations.enabled)OFFの間は enabled:false で、
 * RightPane は運営タブ自体を表示しない(存在を見せない)。
 */
interface OperationsState {
  enabled: boolean;
  ghDetected: boolean;
  ghPath: string | null;
  adapters: AdapterStatusInfo[];
  /** M37: 発信ドラフトの行き先(GitHub Release)候補 */
  repos: string[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useOperationsStore = create<OperationsState>((set) => ({
  enabled: false,
  ghDetected: false,
  ghPath: null,
  adapters: [],
  repos: [],
  loaded: false,
  refresh: async () => {
    try {
      const status = await window.api.operationsStatus();
      set({ ...status, loaded: true });
    } catch {
      set({ enabled: false, ghDetected: false, ghPath: null, adapters: [], repos: [], loaded: true });
    }
  },
}));
