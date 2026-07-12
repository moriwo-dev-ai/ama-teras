import type { ChoEntry } from '../../shared/types';
import type { LLMProvider } from '../providers/types';

/**
 * M44-2(TUKU-yomi): 気づいて提案する。
 *
 * 「明日の予定変更の話をしてるな」と気づいて「変更しておきましょうか?」と**向こうから**言う。
 * これは月読の中で**一番危ない機能**で、うるさければ即座に嫌われて全部OFFにされる。
 * だから設計は「黙る側に倒す」:
 *
 * - **既定は沈黙**。判定は「話しかけるべき強い理由があるか」であって、「話しかけられるか」ではない
 * - 話しかけるのは**帳に関わる時だけ**(予定の変更・約束の追加・期限の話)。
 *   雑談・独り言・テレビの音には一切反応しない
 * - 割り込み予算(1日N回)と静音時間を必ず通る。予算が尽きたら黙る(鉄則3)
 * - クールダウン(既定10分)。立て続けに話しかけない
 */

export const SUGGEST_PROMPT = [
  'あなたは月読。持ち主の会話を聞いて、**声をかけるべき強い理由があるときだけ**提案します。',
  '',
  '声をかけてよいのは、次のどれかが**はっきり**したときだけ:',
  '- 月の帳にある約束・予定の**変更**が話されている(日時が変わった・中止になった)',
  '- 新しい約束・期限が決まったのに、帳に入っていない',
  '- 帳にある期限が今まさに来ている',
  '',
  '**黙ること**(ほとんどの場合はこちら):',
  '- 雑談・独り言・感想・テレビの音・仕事の会話そのもの',
  '- 迷ったら黙る。**声をかけない方が常に安全**(うるさい月読は電源を切られる)',
  '- 同じことを二度言わない',
  '',
  '形式(JSONのみ):',
  '{"speak":false}  … 黙る',
  '{"speak":true,"say":"明日のレビュー、13時から15時に変えておきましょうか?"}',
  '',
  'say は**1文・20文字前後**。提案は必ず疑問形で終える(勝手にやらない)。',
].join('\n');

export interface Suggestion {
  speak: boolean;
  say?: string;
}

/** モデルの返事から提案を取り出す。**壊れていたら黙る**(迷ったら喋らない側へ) */
export function parseSuggestion(raw: string): Suggestion {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced !== null ? fenced[1] : raw) ?? '';
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { speak: false };
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return { speak: false };
    const rec = parsed as Record<string, unknown>;
    const say = rec['say'];
    if (rec['speak'] !== true || typeof say !== 'string' || say.trim() === '') return { speak: false };
    return { speak: true, say: say.trim() };
  } catch {
    return { speak: false };
  }
}

/** 立て続けに話しかけない。10分に1回まで(予算とは別の、体感のための間隔) */
export const SUGGEST_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 判定にかける前の足切り(**LLMを呼ぶ前に**捨てる)。
 * 呼ばれてもいない発話のたびに判定APIを叩けば、黙っているだけで課金が続く
 */
export function worthJudging(recent: string[]): boolean {
  const text = recent.join('');
  if (text.length < 20) return false; // 相槌・短い独り言
  // 帳に関わる語が1つも無ければ、そもそも提案の余地がない
  return /予定|約束|明日|明後日|来週|今日|時|日|変更|キャンセル|延期|締切|期限|やる|やらない/.test(text);
}

export interface SuggestDeps {
  provider: LLMProvider;
  entries: ChoEntry[];
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

/** 直近の発話から提案を作る。**黙るのが既定** */
export async function suggestFrom(
  recent: string[],
  deps: SuggestDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<Suggestion> {
  if (!worthJudging(recent)) return { speak: false };
  const cho = deps.entries
    .filter((e) => e.kind !== 'observation' && e.done !== true)
    .slice(-15)
    .map((e) => `- ${e.text}${e.due !== undefined ? ` [期日 ${e.due}]` : ''}`)
    .join('\n');

  let text = '';
  for await (const event of deps.provider.complete({
    system: SUGGEST_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `月の帳:\n${cho === '' ? '(空)' : cho}\n\n直近の発話:\n${recent.join('\n')}`,
          },
        ],
      },
    ],
    tools: [],
    maxTokens: 200,
    signal,
  })) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'message_done') deps.onUsage?.(event.usage.inputTokens, event.usage.outputTokens);
  }
  return parseSuggestion(text);
}
