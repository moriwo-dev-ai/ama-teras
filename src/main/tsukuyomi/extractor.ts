import type { ChoEntry } from '../../shared/types';
import type { LLMProvider } from '../providers/types';

/**
 * M42-5(TUKU-yomi): 耳 — 文字起こしから「自分の約束・決定・ToDo」だけを抜き出す。
 *
 * 鉄則1: **主語は常に本人**。他人の発言は「自分の約束に関わる要件」だけ拾い、
 * 他人をジャッジする記述は作らない。生の文字起こしは抽出後に捨てる(帳に残るのは結果だけ)。
 *
 * 話者識別はしない(スコープ外)。「主語=本人のみ」というプロンプトの制約に任せる。
 * その限界は PROGRESS.md に明記する — 同席者の「私はやります」を本人の約束と
 * 取り違える可能性が残る。だから**抽出結果は必ず確認UIを通してから帳へ**(勝手に書かない)。
 */

export const EXTRACT_PROMPT = [
  'これは会話の文字起こしです。話者はあなたの持ち主(以下「本人」)と、その周囲の人です。',
  '',
  '**本人自身の**約束・決定・ToDo だけを JSON 配列で書き出してください。',
  '',
  '守ること:',
  '- 本人が「やる」と言ったこと・決めたこと・約束したことだけを拾う',
  '- 他人の発言は、**本人の約束に関わる要件**(期限・条件・宛先)としてのみ拾う',
  '- 他人の人物評・感想・約束は書かない',
  '- 雑談・相槌・意味のない発話は無視する',
  '- 該当が無ければ [] を返す(無理に作らない)',
  // 実機: 「明日の13時にレビュー」が「明日13日にレビュー」になった。時刻の取り違えは
  // 記憶の義手として致命的なので、数字は言い換えさせない
  '- **数字・時刻・日付・固有名詞は文字起こしのまま写す**。言い換え・要約で変えない',
  '',
  '形式(JSON配列のみ。前後に説明を書かない):',
  '[{"kind":"promise|decision|todo","text":"一文で。主語は本人","due":"2026-07-13T13:00"}]',
  // 実機: due に文字列「省略」がそのまま入って保存された。空欄はキーごと出させる
  '- due は分かる時だけ。**分からなければ due のキーごと書かない**(「省略」等と書かない)',
  '- due は "YYYY-MM-DDTHH:mm" か "YYYY-MM-DD" のどちらかだけ',
].join('\n');

/** 「明日の13時」を日付にするには今日が要る。プロンプトの先頭に足す */
export function extractPromptFor(now: Date): string {
  const d = [
    `今日は ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    `(${['日', '月', '火', '水', '木', '金', '土'][now.getDay()]}曜)です。`,
    '「明日」「来週」はこれを基準に due へ変換してください。',
  ].join('');
  return `${d}\n\n${EXTRACT_PROMPT}`;
}

/** due として使える形だけ通す(「省略」「未定」等の文字列を日付欄に入れさせない) */
const DUE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/;

export type ExtractedItem = Pick<ChoEntry, 'kind' | 'text'> & { due?: string };

/** JSONの取り出しは防御的に(コードフェンス・前後の説明・壊れたJSONに耐える) */
export function parseExtraction(raw: string): ExtractedItem[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced !== null ? fenced[1] : raw) ?? '';
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedItem[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const kind = rec['kind'];
    const text = rec['text'];
    if (kind !== 'promise' && kind !== 'decision' && kind !== 'todo') continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    const due = rec['due'];
    const dueOk = typeof due === 'string' && DUE_RE.test(due.trim());
    out.push({
      kind,
      text: text.trim(),
      ...(dueOk ? { due: (due as string).trim() } : {}),
    });
  }
  return out;
}

export interface ExtractorDeps {
  provider: LLMProvider;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  /** 「明日」を日付に直すための基準日 */
  now?: Date;
}

/**
 * 文字起こし → 抽出候補。**帳には書かない**(候補を返すだけ)。
 * 帳に入れるのは人間が確認UIで承認したときだけ — 岩戸の思想(勝手に書かない)
 */
export async function extractCommitments(
  transcript: string,
  deps: ExtractorDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<ExtractedItem[]> {
  if (transcript.trim() === '') return [];
  let text = '';
  for await (const event of deps.provider.complete({
    system: 'あなたは月読。本人の記憶の義手です。他人を評価せず、本人の約束だけを静かに書き留めます。',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${extractPromptFor(deps.now ?? new Date())}\n\n---\n${transcript}` },
        ],
      },
    ],
    tools: [],
    maxTokens: 1000,
    signal,
  })) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'message_done') deps.onUsage?.(event.usage.inputTokens, event.usage.outputTokens);
  }
  return parseExtraction(text);
}
