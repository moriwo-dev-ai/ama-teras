// M1用のダミーエージェント。IPC往復とストリーミング表示を実証するためのエコー応答。
// M3で本物のエージェントループ(agent/loop.ts)に置き換わる。

export function chunkText(text: string, size: number): string[] {
  if (size <= 0) throw new Error(`chunk size must be positive: ${size}`);
  const chunks: string[] = [];
  for (const [i, ch] of [...text].entries()) {
    if (i % size === 0) chunks.push(ch);
    else chunks[chunks.length - 1] += ch;
  }
  return chunks;
}

export interface EchoCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onCancelled: () => void;
}

/** テキストをチャンクに割って擬似ストリーミングする。AbortSignal で即時キャンセル可能 */
export async function streamEcho(
  text: string,
  signal: AbortSignal,
  cb: EchoCallbacks,
  delayMs = 30,
): Promise<void> {
  const reply = `(echo) ${text}`;
  for (const chunk of chunkText(reply, 3)) {
    if (signal.aborted) {
      cb.onCancelled();
      return;
    }
    cb.onDelta(chunk);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (signal.aborted) {
    cb.onCancelled();
    return;
  }
  cb.onDone();
}
