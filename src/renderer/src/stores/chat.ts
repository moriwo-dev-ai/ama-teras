import { create } from 'zustand';
import type { AgentEvent, AgentStatus } from '../../../shared/types';

export type UiMessage =
  | { id: string; role: 'user' | 'assistant'; text: string; streaming: boolean }
  | {
      id: string;
      role: 'tool';
      name: string;
      inputPreview: string;
      resultContent: string;
      isError: boolean;
      running: boolean;
    };

interface ChatState {
  messages: UiMessage[];
  status: AgentStatus;
  activeSessionId: string | null;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  handleEvent: (event: AgentEvent) => void;
}

const TERMINAL: AgentStatus[] = ['done', 'cancelled', 'error', 'max_turns_reached'];

function appendAssistantDelta(messages: UiMessage[], text: string): UiMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && last.streaming) {
    return messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'assistant' ? { ...m, text: m.text + text } : m,
    );
  }
  return [...messages, { id: crypto.randomUUID(), role: 'assistant', text, streaming: true }];
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
      set({ activeSessionId: sessionId });
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
    switch (event.kind) {
      case 'status':
        set({ status: event.status });
        if (TERMINAL.includes(event.status)) {
          set((s) => ({
            activeSessionId: null,
            status: 'idle',
            messages: s.messages.map((m) =>
              m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
            ),
          }));
        }
        break;
      case 'text_delta':
        set((s) => ({ messages: appendAssistantDelta(s.messages, event.text) }));
        break;
      case 'message_done':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
          ),
        }));
        break;
      case 'tool_start':
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: event.toolUseId,
              role: 'tool',
              name: event.name,
              inputPreview: event.inputPreview,
              resultContent: '',
              isError: false,
              running: true,
            },
          ],
        }));
        break;
      case 'tool_result':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.role === 'tool' && m.id === event.toolUseId
              ? { ...m, resultContent: event.content, isError: event.isError, running: false }
              : m,
          ),
        }));
        break;
      case 'error':
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              text: `[エラー] ${event.message}`,
              streaming: false,
            },
          ],
        }));
        break;
    }
  },
}));
