import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequestPayload } from '../../../shared/types';
import { useApprovalStore } from './approval';
import { useEvolutionStore } from './evolution';

/**
 * M10-5: 承認の競合(デスクトップ/リモートの first-response-wins)。
 * リモート側が先に応答した場合、デスクトップの開いたままのダイアログが
 * approval:resolved / job_update で閉じることを store 単位で検証する。
 */

const req = (id: string): ApprovalRequestPayload => ({
  id,
  toolName: 'bash',
  risk: 'exec',
  inputPreview: '{}',
  warnings: [],
});

beforeEach(() => {
  useApprovalStore.setState({ queue: [] });
  useEvolutionStore.setState({ jobs: [], promotion: null });
});

describe('approval store: リモート解決でダイアログが閉じる', () => {
  it('resolveExternally は該当IDだけをキューから外す', () => {
    useApprovalStore.getState().enqueue(req('a'));
    useApprovalStore.getState().enqueue(req('b'));
    useApprovalStore.getState().resolveExternally('a');
    expect(useApprovalStore.getState().queue.map((r) => r.id)).toEqual(['b']);
  });

  it('未知のIDの resolveExternally は何もしない', () => {
    useApprovalStore.getState().enqueue(req('a'));
    useApprovalStore.getState().resolveExternally('unknown');
    expect(useApprovalStore.getState().queue).toHaveLength(1);
  });
});

describe('evolution store: リモートの昇格応答でダイアログが閉じる', () => {
  it('awaiting_promotion を抜けた job_update で promotion が閉じる', () => {
    const store = useEvolutionStore.getState();
    store.handleEvent({
      kind: 'promotion_request',
      jobId: 5,
      toolName: 'x',
      diff: 'd',
      warnings: [],
    });
    expect(useEvolutionStore.getState().promotion?.jobId).toBe(5);

    // 昇格処理中への遷移(リモートが承認した)
    useEvolutionStore.getState().handleEvent({
      kind: 'job_update',
      job: { id: 5, description: 'x', status: 'promoting', log: [], gates: [] },
    });
    expect(useEvolutionStore.getState().promotion).toBeNull();
  });

  it('別ジョブの job_update では閉じない', () => {
    useEvolutionStore.getState().handleEvent({
      kind: 'promotion_request',
      jobId: 5,
      toolName: 'x',
      diff: 'd',
      warnings: [],
    });
    useEvolutionStore.getState().handleEvent({
      kind: 'job_update',
      job: { id: 6, description: 'y', status: 'done', log: [], gates: [] },
    });
    expect(useEvolutionStore.getState().promotion?.jobId).toBe(5);
  });
});
