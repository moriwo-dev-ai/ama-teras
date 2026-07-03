import { create } from 'zustand';
import type { EvolutionEvent, EvolutionJobSummary } from '../../../shared/types';

export interface PromotionRequest {
  jobId: number;
  toolName: string;
  diff: string;
  warnings: string[];
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
        return { jobs };
      });
    } else if (event.kind === 'promotion_request') {
      set({
        promotion: {
          jobId: event.jobId,
          toolName: event.toolName,
          diff: event.diff,
          warnings: event.warnings,
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
