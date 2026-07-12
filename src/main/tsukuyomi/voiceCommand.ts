import type { ChoEntry } from '../../shared/types';
import { parseIntent, type VoiceIntent } from '../../shared/voiceIntent';
import type { LLMProvider } from '../providers/types';

/**
 * M44-1(TUKU-yomi): 声 → 意図。
 *
 * モデルには**許可リストの中から選ばせるだけ**。自由記述のコマンドは作らせない
 * (「何をするか」をモデルに書かせた瞬間、言い間違いと誤認識が実行に化ける)。
 * 該当が無ければ null を返し、普通の会話として応答する
 */

export const INTENT_PROMPT = [
  'あなたは月読。持ち主の発話が「AMA-terasへの操作依頼」かどうかを判定します。',
  '',
  '操作(この中からだけ選ぶ。当てはまらなければ null):',
  '- read.status … 実行中のタスクの状況を知りたい',
  '- read.approvals … 承認待ちが何件あるか知りたい',
  '- read.cho … 帳(約束・ToDo)の中身を知りたい',
  '- cho.add … 帳に覚えさせたい(target=覚える内容)',
  '- cho.done … 帳の項目を済みにしたい(target=どの項目か。帳の文言に近い言葉で)',
  '- ops.godRun … 神(定例の仕事)を今すぐ動かしたい(target=神のID)',
  '- blocked.publish … X/Bluesky/Zennへの投稿・GitHubリリースの公開を頼まれた',
  '',
  '守ること:',
  '- **雑談・質問・独り言は操作ではない**。迷ったら null(黙って会話として返す方が安全)',
  '- 投稿・公開・リリースの依頼は必ず blocked.publish(声では実行しない)',
  '- say には持ち主に読み上げる確認の一文を書く(例「明日13時のレビューを済みにします」)',
  '',
  '形式(JSONのみ。当てはまらなければ null とだけ書く):',
  '{"action":"cho.done","target":"明日13時のレビュー","say":"明日13時のレビューを済みにします"}',
].join('\n');

export interface IntentDeps {
  provider: LLMProvider;
  /** 帳(cho.done の対象を「帳の文言」で指せるように渡す) */
  entries: ChoEntry[];
  /** 動かせる神のID(許可リスト。ここに無い神は動かさない) */
  godIds: string[];
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

/** 発話が操作依頼なら意図を返す。違えば null(普通の会話として応答する) */
export async function detectIntent(
  said: string,
  deps: IntentDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<VoiceIntent | null> {
  if (said.trim() === '') return null;
  const context = [
    deps.entries.length > 0
      ? `帳:\n${deps.entries
          .filter((e) => e.kind !== 'observation' && e.done !== true)
          .slice(-15)
          .map((e) => `- ${e.text}`)
          .join('\n')}`
      : '帳: (空)',
    `動かせる神: ${deps.godIds.length > 0 ? deps.godIds.join(', ') : '(なし)'}`,
  ].join('\n\n');

  let text = '';
  for await (const event of deps.provider.complete({
    system: INTENT_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${context}\n\n発話:\n${said}` }] }],
    tools: [],
    maxTokens: 300,
    signal,
  })) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'message_done') deps.onUsage?.(event.usage.inputTokens, event.usage.outputTokens);
  }
  const intent = parseIntent(text);
  if (intent === null) return null;
  // 知らない神は動かさない(モデルが名前を作っても実行に行かせない)
  if (intent.action === 'ops.godRun' && !deps.godIds.includes(intent.target ?? '')) return null;
  return intent;
}
