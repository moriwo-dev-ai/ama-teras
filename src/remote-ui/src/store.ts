import { create } from 'zustand';
import type {
  AgentEvent,
  AgentStatusView,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  EvolutionEvent,
  EvolutionJobSummary,
  HistoryMessageView,
  RemoteSnapshot,
} from '../../shared/types';

/** チャット表示用メッセージ(desktop の chat store と同形の簡易版) */
export type UiMessage =
  | { id: string; role: 'user' | 'assistant'; text: string; streaming: boolean }
  | {
      id: string;
      role: 'tool';
      name: string;
      resultContent: string;
      isError: boolean;
      running: boolean;
    };

export type PromotionRequest = Extract<EvolutionEvent, { kind: 'promotion_request' }>;

let uiId = 0;
const nextId = (): string => `ui-${++uiId}`;

/** snapshot の履歴を表示メッセージへ変換 */
export function historyToMessages(history: HistoryMessageView[]): UiMessage[] {
  return history.map((h) => ({ id: nextId(), role: h.role, text: h.text, streaming: false }));
}

/**
 * chat:event を messages に反映する純関数(テスト可能にするため store から分離)。
 * desktop の stores/chat.ts と同じ規則。
 */
export function applyChatEvent(messages: UiMessage[], event: AgentEvent): UiMessage[] {
  switch (event.kind) {
    case 'text_delta': {
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        return messages.map((m, i) =>
          i === messages.length - 1 && m.role === 'assistant' ? { ...m, text: m.text + event.text } : m,
        );
      }
      return [...messages, { id: nextId(), role: 'assistant', text: event.text, streaming: true }];
    }
    case 'message_done':
      return messages.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m));
    case 'tool_start':
      return [
        ...messages,
        {
          id: event.toolUseId,
          role: 'tool',
          name: event.name,
          resultContent: '',
          isError: false,
          running: true,
        },
      ];
    case 'tool_result':
      return messages.map((m) =>
        m.role === 'tool' && m.id === event.toolUseId
          ? { ...m, resultContent: event.content, isError: event.isError, running: false }
          : m,
      );
    case 'error':
      return [...messages, { id: nextId(), role: 'assistant', text: `[エラー] ${event.message}`, streaming: false }];
    case 'info':
      // M16-1: システム通知(モデル切替・フォールバック等)
      return [...messages, { id: nextId(), role: 'assistant', text: `ℹ️ ${event.message}`, streaming: false }];
    case 'review': {
      // M19: レビューカード(remote-uiはテキスト整形で表示)
      const icon = event.unresolved === true ? '🔴 残課題あり' : event.pass ? '✅ 合格' : '🔶 不合格→差し戻し';
      const lines = [
        `🧪 品質レビュー${event.round > 0 ? `(再レビュー${event.round}回目)` : ''} ${icon} ${event.average.toFixed(1)}/5 — ${event.milestone}`,
      ];
      if (event.summary) lines.push(event.summary);
      for (const f of event.findings) lines.push(`・${f.file}(${f.location}): ${f.problem} → 修正: ${f.fix}`);
      return [...messages, { id: nextId(), role: 'assistant', text: lines.join('\n'), streaming: false }];
    }
    case 'tool_progress':
      // M21-4: 実行中ツールのライブ出力(runningの間だけ本文へ流し込む)
      return messages.map((m) =>
        m.role === 'tool' && m.id === event.toolUseId && m.running
          ? { ...m, resultContent: event.outputTail }
          : m,
      );
    case 'instruction_queued':
      // M21-1: 実行中の追加指示(desktop/remoteどちらから送ってもこのイベントで表示が揃う)
      return [
        ...messages,
        { id: nextId(), role: 'user', text: `↩ [追加指示] ${event.text}`, streaming: false },
      ];
    case 'status':
      if (TERMINAL.includes(event.status)) {
        return messages.map((m) => (m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m));
      }
      return messages;
    default:
      return messages;
  }
}

const TERMINAL = ['done', 'cancelled', 'error', 'max_turns_reached'];

export type Tab = 'chat' | 'approvals' | 'evolution' | 'audit';

interface RemoteState {
  connected: boolean;
  status: AgentStatusView;
  messages: UiMessage[];
  /** M22: 表示中の会話ID(chat:eventのフィルタ用。null=未確定) */
  conversationId: string | null;
  pendingApprovals: ApprovalRequestPayload[];
  promotions: PromotionRequest[];
  jobs: EvolutionJobSummary[];
  tab: Tab;

  setConnected: (connected: boolean) => void;
  setTab: (tab: Tab) => void;
  applySnapshot: (snapshot: RemoteSnapshot) => void;
  onChatEvent: (event: AgentEvent) => void;
  onApprovalRequest: (req: ApprovalRequestPayload) => void;
  onApprovalResolved: (payload: ApprovalResolvedPayload) => void;
  onEvolutionEvent: (event: EvolutionEvent) => void;
  /** ユーザー送信をローカルに反映(サーバ履歴には chatSend 側で載る) */
  addLocalUserMessage: (text: string) => void;
  /** M15.1: セッション切替後に履歴を丸ごと差し替える(M22: 会話IDも更新) */
  replaceHistory: (history: RemoteSnapshot['history'], conversationId?: string | null) => void;
  /** M17-2: 自律モードの状態反映(SSE autonomous:changed) */
  setAutonomousFlag: (on: boolean) => void;
}

const IDLE: AgentStatusView = { status: 'idle', activeSessionId: null, scopeMode: 'project', autonomous: false };

export const useRemoteStore = create<RemoteState>((set) => ({
  connected: false,
  status: IDLE,
  messages: [],
  conversationId: null,
  pendingApprovals: [],
  promotions: [],
  jobs: [],
  tab: 'chat',

  setConnected: (connected) => set({ connected }),
  setTab: (tab) => set({ tab }),

  applySnapshot: (snapshot) =>
    set({
      status: snapshot.status,
      messages: historyToMessages(snapshot.history),
      pendingApprovals: snapshot.pendingApprovals,
      promotions: snapshot.pendingPromotions,
      jobs: snapshot.jobs,
      conversationId: snapshot.conversationId ?? null,
    }),

  replaceHistory: (history, conversationId) =>
    set((s) => ({
      messages: historyToMessages(history),
      conversationId: conversationId !== undefined ? conversationId : s.conversationId,
    })),

  setAutonomousFlag: (on) => set((s) => ({ status: { ...s.status, autonomous: on } })),

  onChatEvent: (event) =>
    set((s) => {
      // M22: 表示中の会話のイベントだけ反映する(未確定なら採用)
      if (event.conversationId !== undefined && s.conversationId !== null && event.conversationId !== s.conversationId) {
        return s;
      }
      const adopt =
        event.conversationId !== undefined && s.conversationId === null
          ? { conversationId: event.conversationId }
          : {};
      const messages = applyChatEvent(s.messages, event);
      if (event.kind === 'status') {
        const terminal = TERMINAL.includes(event.status);
        return {
          ...adopt,
          messages,
          status: {
            ...s.status,
            status: terminal ? 'idle' : event.status,
            activeSessionId: terminal ? null : event.sessionId,
          },
        };
      }
      return { ...adopt, messages };
    }),

  onApprovalRequest: (req) =>
    set((s) => ({
      pendingApprovals: s.pendingApprovals.some((p) => p.id === req.id)
        ? s.pendingApprovals
        : [...s.pendingApprovals, req],
    })),

  onApprovalResolved: (payload) =>
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((p) => p.id !== payload.id) })),

  onEvolutionEvent: (event) =>
    set((s) => {
      if (event.kind === 'job_update') {
        const jobs = s.jobs.some((j) => j.id === event.job.id)
          ? s.jobs.map((j) => (j.id === event.job.id ? event.job : j))
          : [...s.jobs, event.job];
        // 昇格待ちを抜けたジョブの promotion カードは閉じる
        const promotions =
          event.job.status === 'awaiting_promotion'
            ? s.promotions
            : s.promotions.filter((p) => p.jobId !== event.job.id);
        return { jobs, promotions };
      }
      return {
        promotions: s.promotions.some((p) => p.jobId === event.jobId)
          ? s.promotions
          : [...s.promotions, event],
      };
    }),

  addLocalUserMessage: (text) =>
    set((s) => ({
      messages: [...s.messages, { id: nextId(), role: 'user', text, streaming: false }],
    })),
}));
