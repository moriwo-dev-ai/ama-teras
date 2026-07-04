import { beforeEach, describe, expect, it } from 'vitest';
import type { RemoteSnapshot } from '../../shared/types';
import { applyChatEvent, historyToMessages, useRemoteStore, type UiMessage } from './store';

const SNAPSHOT: RemoteSnapshot = {
  status: { status: 'idle', activeSessionId: null, scopeMode: 'project' },
  history: [
    { role: 'user', text: 'こんにちは' },
    { role: 'assistant', text: 'やあ' },
  ],
  pendingApprovals: [],
  pendingPromotions: [],
  jobs: [],
  tools: [],
};

beforeEach(() => {
  useRemoteStore.getState().applySnapshot(SNAPSHOT);
});

describe('applyChatEvent', () => {
  it('text_delta はストリーミング中の assistant へ追記し、無ければ新規作成する', () => {
    let messages: UiMessage[] = [];
    messages = applyChatEvent(messages, { kind: 'text_delta', sessionId: 's', text: 'こん' });
    messages = applyChatEvent(messages, { kind: 'text_delta', sessionId: 's', text: 'にちは' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'assistant', text: 'こんにちは', streaming: true });

    messages = applyChatEvent(messages, { kind: 'message_done', sessionId: 's' });
    expect(messages[0]).toMatchObject({ streaming: false });

    // done 後の delta は新しい吹き出しになる
    messages = applyChatEvent(messages, { kind: 'text_delta', sessionId: 's', text: '次' });
    expect(messages).toHaveLength(2);
  });

  it('tool_start → tool_result でカードが更新される', () => {
    let messages: UiMessage[] = [];
    messages = applyChatEvent(messages, {
      kind: 'tool_start',
      sessionId: 's',
      toolUseId: 't1',
      name: 'read_file',
      inputPreview: '{}',
    });
    expect(messages[0]).toMatchObject({ role: 'tool', name: 'read_file', running: true });
    messages = applyChatEvent(messages, {
      kind: 'tool_result',
      sessionId: 's',
      toolUseId: 't1',
      name: 'read_file',
      content: '中身',
      isError: false,
    });
    expect(messages[0]).toMatchObject({ role: 'tool', resultContent: '中身', running: false });
  });

  it('error はメッセージとして表示される', () => {
    const messages = applyChatEvent([], { kind: 'error', sessionId: 's', message: '壊れた' });
    expect(messages[0]).toMatchObject({ role: 'assistant', text: '[エラー] 壊れた' });
  });
});

describe('useRemoteStore', () => {
  it('snapshot が履歴・状態を上書きする', () => {
    const s = useRemoteStore.getState();
    expect(s.messages.map((m) => (m.role === 'tool' ? '' : m.text))).toEqual(['こんにちは', 'やあ']);
    expect(s.status.status).toBe('idle');
  });

  it('承認要求は重複せず追加され、resolved で消える', () => {
    const req = { id: 'ap-1', toolName: 'bash', risk: 'exec' as const, inputPreview: '{}', warnings: [] };
    useRemoteStore.getState().onApprovalRequest(req);
    useRemoteStore.getState().onApprovalRequest(req);
    expect(useRemoteStore.getState().pendingApprovals).toHaveLength(1);
    useRemoteStore.getState().onApprovalResolved({ id: 'ap-1', decision: 'allow' });
    expect(useRemoteStore.getState().pendingApprovals).toHaveLength(0);
  });

  it('job_update はジョブを追加/更新し、昇格待ちを抜けたら promotion カードを閉じる', () => {
    const store = useRemoteStore.getState();
    store.onEvolutionEvent({
      kind: 'promotion_request',
      jobId: 3,
      toolName: 'x',
      diff: 'd',
      warnings: [],
    });
    expect(useRemoteStore.getState().promotions).toHaveLength(1);

    store.onEvolutionEvent({
      kind: 'job_update',
      job: { id: 3, description: 'x', status: 'awaiting_promotion', log: [], gates: [] },
    });
    expect(useRemoteStore.getState().promotions).toHaveLength(1);
    expect(useRemoteStore.getState().jobs).toHaveLength(1);

    store.onEvolutionEvent({
      kind: 'job_update',
      job: { id: 3, description: 'x', status: 'done', log: [], gates: [] },
    });
    expect(useRemoteStore.getState().promotions).toHaveLength(0);
    expect(useRemoteStore.getState().jobs[0]?.status).toBe('done');
  });

  it('terminal status で activeSessionId が外れ、途中 status では設定される', () => {
    const store = useRemoteStore.getState();
    store.onChatEvent({ kind: 'status', sessionId: 'run-1', status: 'calling_llm' });
    expect(useRemoteStore.getState().status.activeSessionId).toBe('run-1');
    store.onChatEvent({ kind: 'status', sessionId: 'run-1', status: 'done' });
    expect(useRemoteStore.getState().status).toMatchObject({ status: 'idle', activeSessionId: null });
  });
});

describe('historyToMessages', () => {
  it('role と text を写し、streaming=false にする', () => {
    const out = historyToMessages([{ role: 'user', text: 'a' }]);
    expect(out[0]).toMatchObject({ role: 'user', text: 'a', streaming: false });
  });
});
