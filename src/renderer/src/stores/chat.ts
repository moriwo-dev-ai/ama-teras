import { create } from 'zustand';
import type { AgentEvent, AgentStatus } from '../../../shared/types';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming: boolean;
}

interface ChatState {
  messages: UiMessage[];
  status: AgentStatus;
  activeSessionId: string | null;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  handleEvent: (event: AgentEvent) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  status: 'idle',
  activeSessionId: null,

  send: async (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().activeSessionId) return;
    set((s) => ({
      messages: [
        ...s.messages,
        { id: crypto.randomUUID(), role: 'user', text: trimmed, streaming: false },
      ],
    }));
    try {
      const { sessionId } = await window.api.chatSend(trimmed);
      set((s) => ({
        activeSessionId: sessionId,
        messages: [...s.messages, { id: sessionId, role: 'assistant', text: '', streaming: true }],
      }));
    } catch (err) {
      set((s) => ({
        status: 'error',
        messages: [
          ...s.messages,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: `エラー: ${err instanceof Error ? err.message : String(err)}`,
            streaming: false,
          },
        ],
      }));
    }
  },

  cancel: () => {
    const id = get().activeSessionId;
    if (id) void window.api.chatCancel(id);
  },

  handleEvent: (event) => {
    if (event.sessionId !== get().activeSessionId) return;
    switch (event.kind) {
      case 'status':
        set({ status: event.status });
        if (['done', 'cancelled', 'error', 'max_turns_reached'].includes(event.status)) {
          set({ activeSessionId: null, status: 'idle' });
        }
        break;
      case 'text_delta':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.sessionId ? { ...m, text: m.text + event.text } : m,
          ),
        }));
        break;
      case 'message_done':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.sessionId ? { ...m, streaming: false } : m,
          ),
        }));
        break;
      case 'error':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.sessionId
              ? { ...m, text: `${m.text}\n[エラー] ${event.message}`, streaming: false }
              : m,
          ),
        }));
        break;
    }
  },
}));
