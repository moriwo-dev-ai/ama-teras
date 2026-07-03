import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from './chat';

// window.api を差し替える最小モック
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let chatSend: ReturnType<typeof vi.fn>;
let chatCancel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  chatSend = vi.fn();
  chatCancel = vi.fn();
  (globalThis as unknown as { window: unknown }).window = { api: { chatSend, chatCancel } };
  useChatStore.setState({ messages: [], status: 'idle', activeSessionId: null });
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('useChatStore', () => {
  it('通常フロー: send で activeSessionId が立ち、終端statusで idle に戻る', async () => {
    chatSend.mockResolvedValue({ sessionId: 's1' });
    await useChatStore.getState().send('hi');
    expect(useChatStore.getState().activeSessionId).toBe('s1');

    useChatStore.getState().handleEvent({ kind: 'status', sessionId: 's1', status: 'done' });
    expect(useChatStore.getState().activeSessionId).toBeNull();
    expect(useChatStore.getState().status).toBe('idle');
  });

  // 回帰(指摘#5): 終端イベントが chatSend の解決より先に届いても送信ロックしない
  it('終端イベントが invoke 解決より先に届いても activeSessionId は残らない', async () => {
    const d = deferred<{ sessionId: string }>();
    chatSend.mockReturnValue(d.promise);

    const sendPromise = useChatStore.getState().send('hi');
    // main が同期的に error+status:error を先に送ってきた状況を再現
    useChatStore.getState().handleEvent({ kind: 'error', sessionId: 's1', message: 'APIキー未設定' });
    useChatStore.getState().handleEvent({ kind: 'status', sessionId: 's1', status: 'error' });
    // その後で invoke が解決
    d.resolve({ sessionId: 's1' });
    await sendPromise;

    // 死んだ sessionId が復活していないこと(=再送信可能)
    expect(useChatStore.getState().activeSessionId).toBeNull();
    // エラーバブルは表示されている
    expect(useChatStore.getState().messages.some((m) => m.role === 'assistant' && m.text.includes('APIキー'))).toBe(true);

    // 実際に次の送信が通ることを確認
    chatSend.mockResolvedValue({ sessionId: 's2' });
    await useChatStore.getState().send('again');
    expect(useChatStore.getState().activeSessionId).toBe('s2');
  });

  it('activeSessionId が立っている間は二重送信しない', async () => {
    chatSend.mockResolvedValue({ sessionId: 's1' });
    await useChatStore.getState().send('hi');
    expect(chatSend).toHaveBeenCalledTimes(1);
    await useChatStore.getState().send('hi2'); // activeSessionId があるので無視
    expect(chatSend).toHaveBeenCalledTimes(1);
  });
});
