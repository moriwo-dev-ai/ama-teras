import { create } from 'zustand';
import type { EvolutionEvent, EvolutionJobSummary, EvolutionScope } from '../../../shared/types';

export interface PromotionRequest {
  jobId: number;
  toolName: string;
  diff: string;
  warnings: string[];
  /** M20: renderer/core は昇格UIで二段確認+本体変更の強調 */
  scope?: EvolutionScope;
  requiresRestart?: boolean;
}

interface EvolutionState {
  jobs: EvolutionJobSummary[];
  promotion: PromotionRequest | null;
  handleEvent: (event: EvolutionEvent) => void;
  respondPromotion: (approved: boolean) => void;
  loadJobs: () => Promise<void>;
}

export const useEvolutionStore = create<EvolutionState>((set, get) => ({
  jobs: [],
  promotion: null,

  handleEvent: (event) => {
    if (event.kind === 'job_update') {
      set((s) => {
        const idx = s.jobs.findIndex((j) => j.id === event.job.id);
        const jobs = idx >= 0 ? s.jobs.map((j, i) => (i === idx ? event.job : j)) : [...s.jobs, event.job];
        // M10: リモート側で昇格承認/却下されたら、開いたままの昇格ダイアログを閉じる
        const promotion =
          s.promotion && s.promotion.jobId === event.job.id && event.job.status !== 'awaiting_promotion'
            ? null
            : s.promotion;
        return { jobs, promotion };
      });
    } else if (event.kind === 'promotion_request') {
      set({
        promotion: {
          jobId: event.jobId,
          toolName: event.toolName,
          diff: event.diff,
          warnings: event.warnings,
          ...(event.scope !== undefined ? { scope: event.scope } : {}),
          ...(event.requiresRestart !== undefined ? { requiresRestart: event.requiresRestart } : {}),
        },
      });
    }
  },

  respondPromotion: (approved) => {
    const p = get().promotion;
    if (!p) return;
    void window.api.evolutionPromoteRespond(p.jobId, approved);
    set({ promotion: null });
  },

  loadJobs: async () => {
    set({ jobs: await window.api.evolutionList() });
  },
}));
