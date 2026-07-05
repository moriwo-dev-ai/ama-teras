import { create } from 'zustand';
import type { AgentEvent, AgentStatus, ChatImageInput, ChatMode, SessionMeta } from '../../../shared/types';

export type UiMessage =
  | { id: string; role: 'user' | 'assistant'; text: string; streaming: boolean; images?: string[] }
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
  /** M12-1: 保存済みセッションの一覧(切替ドロップダウン用) */
  sessions: SessionMeta[];
  send: (text: string, mode?: ChatMode, images?: ChatImageInput[]) => Promise<void>;
  cancel: () => void;
  handleEvent: (event: AgentEvent) => void;
  refreshSessions: () => Promise<void>;
  loadSession: (id: string) => Promise<void>;
  newSession: () => Promise<void>;
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
  sessions: [],

  refreshSessions: async () => {
    try {
      set({ sessions: await window.api.sessionsList() });
    } catch {
      // 一覧取得失敗は致命的でない(次回の更新で回復)
    }
  },

  loadSession: async (id) => {
    if (get().activeSessionId) return; // 実行中は切替不可(main側でも拒否される)
    const result = await window.api.sessionsLoad(id);
    if (!result.ok || !result.history) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: `[エラー] ${result.message ?? 'セッションを開けない'}`,
            streaming: false,
          },
        ],
      }));
      return;
    }
    set({
      messages: result.history.map((h) => ({
        id: crypto.randomUUID(),
        role: h.role,
        text: h.text,
        streaming: false,
      })),
      status: 'idle',
    });
  },

  newSession: async () => {
    if (get().activeSessionId) return;
    const result = await window.api.sessionsNew();
    if (result.ok) set({ messages: [], status: 'idle' });
    await get().refreshSessions();
  },

  send: async (text, mode = 'normal', images) => {
    const trimmed = text.trim();
    // M14-2: 画像のみの送信も許可(「これ見て」を打たなくても伝わる)
    if ((!trimmed && (images?.length ?? 0) === 0) || get().activeSessionId) return;
    const shown = mode === 'plan' ? `📝 [プラン] ${trimmed}` : trimmed;
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: shown,
          streaming: false,
          ...(images && images.length > 0
            ? { images: images.map((i) => `data:${i.mediaType};base64,${i.data}`) }
            : {}),
        },
      ],
    }));
    try {
      const { sessionId } = await window.api.chatSend(trimmed || '(画像を確認して)', mode, images);
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
