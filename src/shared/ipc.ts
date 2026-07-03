import type { AgentEvent } from './types';

/** IPCチャネル名の一元定義。文字列リテラルを直接使わない */
export const IpcChannels = {
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',
} as const;

/** preload が window.api として公開するAPIの型。renderer はこれ経由でしか main と話せない */
export interface MyCodexApi {
  chatSend(text: string): Promise<{ sessionId: string }>;
  chatCancel(sessionId: string): Promise<void>;
  /** 戻り値は購読解除関数 */
  onChatEvent(listener: (event: AgentEvent) => void): () => void;
}
