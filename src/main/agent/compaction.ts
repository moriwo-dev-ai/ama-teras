import type { ChatMessage, CompletionRequest, ContentBlock, LLMProvider } from '../providers/types';

/**
 * コンテキスト自動圧縮(M8-1)。会話履歴の推定トークンが閾値を超えたら、
 * 古いやり取りを LLM で要約し「要約 + 直近の生ログ」に置換する。
 * tool_use と tool_result の対応(指摘#1の不変条件)を壊さない境界で切る。
 */

const CHARS_PER_TOKEN = 4; // 粗い推定(日本語混在のため保守的に短め)
export const DEFAULT_COMPACTION_THRESHOLD = 24_000;
export const DEFAULT_KEEP_RECENT_TURNS = 4;

export interface CompactionOptions {
  thresholdTokens?: number;
  keepRecentTurns?: number;
  signal?: AbortSignal;
}

function blockChars(b: ContentBlock): number {
  if (b.type === 'text') return b.text.length;
  if (b.type === 'tool_result') return b.content.length;
  return b.name.length + JSON.stringify(b.input).length; // tool_use
}

/** 履歴の送信トークンを粗く推定する */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) for (const b of m.content) chars += blockChars(b);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** user(テキスト)メッセージ=新しいターンの開始。tool_result だけの user は境界ではない */
function isUserTurnStart(m: ChatMessage): boolean {
  return m.role === 'user' && m.content[0]?.type === 'text';
}

/**
 * 要約する先頭範囲 [0, split) の split を返す。直近 keepRecentTurns 個の
 * user ターン境界を残す。境界(=user テキスト)で切るので、tool_use を含む
 * assistant とその tool_result(直後の user)を分断しない。0 は圧縮不要。
 */
export function findCompactionSplit(messages: ChatMessage[], keepRecentTurns: number): number {
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isUserTurnStart(messages[i]!)) boundaries.push(i);
  }
  if (boundaries.length <= keepRecentTurns) return 0;
  return boundaries[boundaries.length - keepRecentTurns]!;
}

function renderForSummary(m: ChatMessage): string {
  const parts = m.content.map((b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `[ツール呼び出し ${b.name} ${JSON.stringify(b.input)}]`;
    return `[ツール結果${b.isError ? '(エラー)' : ''}: ${b.content.slice(0, 500)}]`;
  });
  return `${m.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${parts.join(' ')}`;
}

async function summarize(provider: LLMProvider, head: ChatMessage[], signal: AbortSignal): Promise<string> {
  const transcript = head.map(renderForSummary).join('\n');
  const req: CompletionRequest = {
    system:
      '次の会話履歴を、後続の作業に必要な事実・ユーザーの要望・決定事項・現在の状態を保つよう' +
      '簡潔な日本語で要約せよ。コード片やパスなど後で参照しうる具体情報は残す。箇条書き可。',
    messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
    tools: [],
    maxTokens: 1024,
    signal,
  };
  let text = '';
  for await (const ev of provider.complete(req)) {
    if (ev.type === 'message_done') {
      text = ev.message.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
  }
  return text.trim();
}

/**
 * 必要なら history を in-place で圧縮する。圧縮したら true。
 * 履歴配列の参照を保つため splice で先頭を置換する(呼び出し側と共有しているため)。
 */
export async function compactHistory(
  provider: LLMProvider,
  history: ChatMessage[],
  opts: CompactionOptions = {},
): Promise<boolean> {
  const threshold = opts.thresholdTokens ?? DEFAULT_COMPACTION_THRESHOLD;
  const keepRecentTurns = opts.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  if (estimateTokens(history) < threshold) return false;

  const split = findCompactionSplit(history, keepRecentTurns);
  if (split <= 0) return false;

  const head = history.slice(0, split);
  const summary = await summarize(provider, head, opts.signal ?? new AbortController().signal);
  if (summary === '') return false; // 要約に失敗したら圧縮しない(生ログを保持)

  const summaryPair: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `【これまでの会話の要約】\n${summary}` }] },
    { role: 'assistant', content: [{ type: 'text', text: '要約を把握しました。この文脈を踏まえて続けます。' }] },
  ];
  history.splice(0, split, ...summaryPair);
  return true;
}
