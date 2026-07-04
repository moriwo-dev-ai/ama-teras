import { create } from 'zustand';
import type { ApprovalDecision, ApprovalRequestPayload } from '../../../shared/types';

interface ApprovalState {
  queue: ApprovalRequestPayload[];
  enqueue: (req: ApprovalRequestPayload) => void;
  respond: (id: string, decision: ApprovalDecision) => void;
  /** M10: リモート等の別画面で解決された要求をキューから外す(first-response-wins) */
  resolveExternally: (id: string) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  queue: [],
  enqueue: (req) => set((s) => ({ queue: [...s.queue, req] })),
  respond: (id, decision) => {
    void window.api.approvalRespond(id, decision);
    set((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
  },
  resolveExternally: (id) => set((s) => ({ queue: s.queue.filter((r) => r.id !== id) })),
}));
