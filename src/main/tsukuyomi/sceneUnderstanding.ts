import type { LLMProvider } from '../providers/types';

/**
 * M42-4(TUKU-yomi): 目② — 映像理解(選別した静止フレームだけをAPIへ)。
 *
 * **送るのは選別した1枚の静止画だけ**(鉄則2)。映像ストリームも選別外のフレームも外に出ない。
 * 送ったフレームは**保存しない**(メモリ→API→破棄)。上限(1時間6枚・1日50枚)を超えたら
 * 理解だけ止めて、在席検知(ローカル)は続ける(鉄則11)。
 *
 * 何を書かせるか: 「作業状況を日本語一文で」。**人物の評価・容姿・感情の推測は書かせない**。
 * 勇太さん以外の人が映っていても記述しない(他人をジャッジする機能は作らない・鉄則1)。
 */

export const SCENE_PROMPT = [
  'この1枚の静止画から、作業状況を日本語一文で書いてください。',
  '',
  '守ること:',
  '- **人物の評価・容姿・服装・感情の推測は書かない**',
  '- 本人以外の人物が映っていても、その人については何も書かない',
  '- 見えたものだけを書く。推測で補わない',
  '- 分からなければ「不明」とだけ書く',
  '',
  '例: 「机でノートPCに向かって作業している」「席に誰もいない」「不明」',
].join('\n');

/** 一文に収める(帳に残るのは短い一文だけ。長文は月の忘却に合わない) */
export function trimObservation(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const stripped = line.replace(/^[-*・]\s*/, '');
  return stripped.length > 60 ? `${stripped.slice(0, 60)}…` : stripped;
}

/** 空・拒否・意味のない応答は帳に入れない(ゴミを覚えさせない) */
export function isUsefulObservation(text: string): boolean {
  const t = trimObservation(text);
  return t !== '' && t !== '不明' && !/^(すみません|申し訳|I can|I'm sorry)/i.test(t);
}

export interface SceneUnderstandingDeps {
  provider: LLMProvider;
  /** 使用トークンを usage 集計へ(単価不明のモデルでは金額を出さない) */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

/**
 * 1枚のJPEG(base64)から状況の一文を得る。
 * 呼び出し側(manager)が canSendFrame() を通してから呼ぶこと — ここでは上限を見ない
 */
export async function understandScene(
  jpegBase64: string,
  deps: SceneUnderstandingDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ text: string | null; inputTokens: number; outputTokens: number }> {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of deps.provider.complete({
    system: 'あなたは月読。見たものを短く記録するだけの静かな観察者です。',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', data: jpegBase64, mediaType: 'image/jpeg' },
          { type: 'text', text: SCENE_PROMPT },
        ],
      },
    ],
    tools: [],
    maxTokens: 200,
    signal,
  })) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'message_done') {
      inputTokens = event.usage.inputTokens;
      outputTokens = event.usage.outputTokens;
    }
  }

  deps.onUsage?.(inputTokens, outputTokens);
  // フレームはここで捨てる(引数のbase64は呼び出し元が保持しない)
  return { text: isUsefulObservation(text) ? trimObservation(text) : null, inputTokens, outputTokens };
}
