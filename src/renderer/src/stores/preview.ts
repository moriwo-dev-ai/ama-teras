import { create } from 'zustand';
import type { FilePreviewResult } from '../../../shared/types';

/** M15-3: 右ペインのファイルプレビュー状態 */
interface PreviewState {
  result: FilePreviewResult | null;
  requestedPath: string | null;
  open: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
  close: () => void;
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  result: null,
  requestedPath: null,

  open: async (path) => {
    set({ requestedPath: path });
    try {
      set({ result: await window.api.filePreview(path) });
    } catch (err) {
      set({ result: { ok: false, message: err instanceof Error ? err.message : String(err) } });
    }
  },

  refresh: async () => {
    const path = get().requestedPath;
    if (path) await get().open(path);
  },

  close: () => set({ result: null, requestedPath: null }),
}));
