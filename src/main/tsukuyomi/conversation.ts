import type { ChoEntry } from '../../shared/types';
import type { LLMProvider } from '../providers/types';

/**
 * M43-1(TUKU-yomi): 会話。
 *
 * 月読は**沈黙の神**。会話でも饒舌にはしない — 1〜2文で返す(音声で聞くので長文は苦痛)。
 * 答えの根拠は**月の帳**(承認済みの記録)だけ。帳に無いことは「知らない」と言わせる —
 * ここで作話すると「記憶の義手」が嘘をつく道具になる。
 *
 * 鉄則1(他人を評価しない)は会話でも生きている。人物評・感想は求められても言わない。
 */

/** 音声で返すので短く。長い答えは聞いていられない */
export const MAX_REPLY_CHARS = 120;

export const CONVERSATION_SYSTEM = [
  'あなたは月読(TUKU-yomi)。持ち主(本人)の記憶の義手です。',
  '',
  '話し方:',
  '- **1〜2文で返す**。音声で聞くので長い説明はしない',
  '- 静かで簡潔。前置き・相槌・謝罪を書かない',
  '- 聞かれていないことを足さない',
  '',
  '守ること:',
  '- 答えの根拠は**月の帳**(本人が承認した記録)だけ。**帳に無いことは「記録にありません」と言う**',
  '- 推測で予定や約束を作らない(作話は記憶の義手として致命的)',
  '- 他人の人物評・感想は言わない(頼まれても)',
  '- 日付・時刻は帳のとおりに言う。言い換えない',
].join('\n');

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** 会話に渡す帳(多すぎると音声応答が遅くなるので、直近と未完了だけ) */
export function choContext(entries: ChoEntry[], limit = 20): string {
  const useful = entries
    .filter((e) => e.kind !== 'observation' || e.done !== true)
    .slice(-limit)
    .map((e) => {
      const done = e.done === true ? '(済)' : '';
      const due = e.due !== undefined && e.due !== '' ? ` [期日 ${e.due}]` : '';
      return `- ${e.kind}${done}: ${e.text}${due}`;
    });
  if (useful.length === 0) return '(月の帳は空です)';
  return ['月の帳(本人が承認した記録):', ...useful].join('\n');
}

/** 音声で返す前に整える。長すぎる返事は切る(聞いていられない) */
export function trimReply(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= MAX_REPLY_CHARS) return one;
  // 文の切れ目で落とす(途中で切れた文を読み上げない)
  const cut = one.slice(0, MAX_REPLY_CHARS);
  const last = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  return last > 0 ? cut.slice(0, last + 1) : `${cut}…`;
}

export interface ConverseDeps {
  provider: LLMProvider;
  entries: ChoEntry[];
  /** 直近の会話(往復。長くしない — 音声会話は短期の文脈で足りる) */
  history?: ConversationTurn[];
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

/** 直前の往復だけ渡す(古い文脈は音声会話では邪魔になり、トークンも食う) */
export const MAX_HISTORY_TURNS = 6;

export async function converse(
  said: string,
  deps: ConverseDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  if (said.trim() === '') return '';
  const history = (deps.history ?? []).slice(-MAX_HISTORY_TURNS);
  let text = '';
  for await (const event of deps.provider.complete({
    system: `${CONVERSATION_SYSTEM}\n\n${choContext(deps.entries)}`,
    messages: [
      ...history.map((t) => ({
        role: t.role,
        content: [{ type: 'text' as const, text: t.text }],
      })),
      { role: 'user' as const, content: [{ type: 'text' as const, text: said }] },
    ],
    tools: [],
    maxTokens: 300,
    signal,
  })) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'message_done') deps.onUsage?.(event.usage.inputTokens, event.usage.outputTokens);
  }
  return trimReply(text);
}
