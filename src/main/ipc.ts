import { ipcMain, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { IpcChannels } from '../shared/ipc';
import type { AgentEvent } from '../shared/types';
import { streamEcho } from './agent/echo';

// セッションごとのキャンセル用。M3でセッション管理(agent/session.ts)へ移す。
const controllers = new Map<string, AbortController>();

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`IPC payload ${name} must be a string`);
}

export function registerIpcHandlers(getWebContents: () => WebContents | null): void {
  const push = (event: AgentEvent): void => {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) wc.send(IpcChannels.chatEvent, event);
  };

  ipcMain.handle(IpcChannels.chatSend, (_e, text: unknown) => {
    assertString(text, 'text');
    const sessionId = randomUUID();
    const ac = new AbortController();
    controllers.set(sessionId, ac);

    push({ kind: 'status', sessionId, status: 'calling_llm' });
    void streamEcho(text, ac.signal, {
      onDelta: (t) => push({ kind: 'text_delta', sessionId, text: t }),
      onDone: () => {
        controllers.delete(sessionId);
        push({ kind: 'message_done', sessionId });
        push({ kind: 'status', sessionId, status: 'done' });
      },
      onCancelled: () => {
        controllers.delete(sessionId);
        push({ kind: 'message_done', sessionId });
        push({ kind: 'status', sessionId, status: 'cancelled' });
      },
    }).catch((err: unknown) => {
      controllers.delete(sessionId);
      push({ kind: 'error', sessionId, message: err instanceof Error ? err.message : String(err) });
      push({ kind: 'status', sessionId, status: 'error' });
    });

    return { sessionId };
  });

  ipcMain.handle(IpcChannels.chatCancel, (_e, sessionId: unknown) => {
    assertString(sessionId, 'sessionId');
    controllers.get(sessionId)?.abort();
  });
}
