import { create } from 'zustand';
import type { AgentEvent, AgentStatus, ChatMode } from '../../../shared/types';

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
  send: (text: string, mode?: ChatMode) => Promise<void>;
  cancel: () => void;
  handleEvent: (event: AgentEvent) => void;
}

const TERMINAL: AgentStatus[] = ['done', 'cancelled', 'error', 'max_turns_reached'];

// main が同期的に error+終端status を送ってから sessionId を返す経路では、
// 終端イベントが send() の activeSessionId 設定より先に届きうる。その場合に
// 死んだ sessionId を activeSessionId へ再セットすると送信が恒久ロックするため、
// 「先に終了した sessionId」をここへ記録し send 側で無視する(指摘#5)。
const earlyFinished = new Set<string>();

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

  send: async (text, mode = 'normal') => {
    const trimmed = text.trim();
    if (!trimmed || get().activeSessionId) return;
    const shown = mode === 'plan' ? `📝 [プラン] ${trimmed}` : trimmed;
    set((s) => ({
      messages: [
        ...s.messages,
        { id: crypto.randomUUID(), role: 'user', text: shown, streaming: false },
      ],
    }));
    try {
      const { sessionId } = await window.api.chatSend(trimmed, mode);
      // このセッションの終端イベントが既に届いていたら activeSessionId を復活させない
      if (earlyFinished.delete(sessionId)) return;
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
        if (TERMINAL.includes(event.status)) {
          // activeSessionId 未設定の状態で終端が来た(= send の await 前に先着した)なら
          // 後から来る sessionId を無視させるため記録する
          if (get().activeSessionId !== event.sessionId) earlyFinished.add(event.sessionId);
          set((s) => ({
            activeSessionId: null,
            status: 'idle',
            messages: s.messages.map((m) =>
              m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
            ),
          }));
        } else {
          set({ status: event.status });
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
