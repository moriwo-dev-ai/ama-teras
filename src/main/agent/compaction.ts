import type { ChatMessage, CompletionRequest, ContentBlock, LLMProvider } from '../providers/types';

/**
 * コンテキスト自動圧縮(M8-1、M13-1で強化)。履歴が閾値を超えたら段階的に圧縮する:
 * 1. 第1段(軽量): 古いターンの tool_result 本文を切り詰める(ペア構造は不変)
 * 2. 第2段: 古いやり取りを LLM で構造化要約し「要約 + 直近の生ログ」に置換。
 *    要約で消える範囲の重要知見は onMemoryEscape 経由で MYCODEX.md へ退避できる
 * トリガーは実測トークン(measuredTokens: 直近APIコールの input+cache_read)を優先し、
 * 無い場合のみ文字数推定へフォールバック(セッション保存の畳み込み等)。
 * tool_use と tool_result の対応(指摘#1の不変条件)を壊さない境界で切る。
 */

const CHARS_PER_TOKEN = 4; // 粗い推定(日本語混在のため保守的に短め)
export const DEFAULT_COMPACTION_THRESHOLD = 24_000;
export const DEFAULT_KEEP_RECENT_TURNS = 4;
/** 第1段: この長さ(chars≒4KB)を超える古い tool_result を切り詰める */
export const TRUNCATE_IF_LONGER_THAN = 4096;
/** 第1段: 切り詰め後に残す先頭(chars≒1KB) */
export const TRUNCATE_KEEP = 1024;

export interface CompactionOptions {
  thresholdTokens?: number;
  keepRecentTurns?: number;
  signal?: AbortSignal;
  /**
   * M13-1: 直近APIコールの実測プロンプトトークン(inputTokens + cacheReadTokens)。
   * 指定時はこちらで発火判定する(文字数推定は使わない)
   */
  measuredTokens?: number;
  /** M13-1: 要約から「## 記憶へ退避」を抽出できたときに呼ばれる(MYCODEX.mdへの追記等) */
  onMemoryEscape?: (text: string) => void;
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

/** M13-1: 構造化要約のセクション(テストで固定。要約の質のブレを減らす) */
export const SUMMARY_SECTIONS = [
  '## 依頼の目的',
  '## 完了したこと',
  '## 触ったファイル',
  '## 決定事項と理由',
  '## 未解決・次にやること',
] as const;

const MEMORY_ESCAPE_HEADING = '## 記憶へ退避';

async function summarize(provider: LLMProvider, head: ChatMessage[], signal: AbortSignal): Promise<string> {
  const transcript = head.map(renderForSummary).join('\n');
  const req: CompletionRequest = {
    system:
      '次の会話履歴を、後続の作業に必要な情報を保つよう簡潔な日本語で要約せよ。' +
      `必ず次の見出しの順で構成すること: ${SUMMARY_SECTIONS.join(' / ')}。` +
      'コード片・パス・コマンドなど後で参照しうる具体情報は残す。各節は箇条書き可、該当なしは「なし」。' +
      `さらに、この履歴が消えた後も将来の別作業で役立つ普遍的な知見(ビルド方法・規約・ハマりどころ)が` +
      `あれば、末尾に「${MEMORY_ESCAPE_HEADING}」見出しで1〜3行の箇条書きにせよ(無ければ見出し自体を出さない)。`,
    messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
    tools: [],
    maxTokens: 1536,
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

/** 要約本文から「## 記憶へ退避」節を切り出す。戻り値は [退避を除いた要約, 退避テキスト|null] */
export function splitMemoryEscape(summary: string): [string, string | null] {
  const idx = summary.indexOf(MEMORY_ESCAPE_HEADING);
  if (idx < 0) return [summary, null];
  const escaped = summary.slice(idx + MEMORY_ESCAPE_HEADING.length).trim();
  return [summary.slice(0, idx).trimEnd(), escaped === '' ? null : escaped];
}

/**
 * M13-1 第1段圧縮: split 境界より古いメッセージの tool_result 本文を切り詰める。
 * content 文字列のみ変更し、ブロック数・toolUseId・並びは一切変えない
 * (tool_use/tool_result のペア構造を壊さない = API 400 の回帰防止)。
 * 戻り値は切り詰めたブロック数。
 */
export function truncateOldToolResults(
  messages: ChatMessage[],
  keepRecentTurns: number = DEFAULT_KEEP_RECENT_TURNS,
): number {
  const split = findCompactionSplit(messages, keepRecentTurns);
  if (split <= 0) return 0;
  let truncated = 0;
  for (let i = 0; i < split; i++) {
    for (const block of messages[i]!.content) {
      if (block.type === 'tool_result' && block.content.length > TRUNCATE_IF_LONGER_THAN) {
        block.content = `${block.content.slice(0, TRUNCATE_KEEP)}\n…[古いツール結果のため切り詰め済み]`;
        truncated++;
      }
    }
  }
  return truncated;
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
  // 実測トークン(直近APIコールのプロンプト側)があればそれで判定、無ければ文字数推定
  const over =
    opts.measuredTokens !== undefined
      ? opts.measuredTokens >= threshold
      : estimateTokens(history) >= threshold;
  if (!over) return false;

  // 第1段(軽量): 古い tool_result の切り詰め。これだけで推定が閾値を下回れば要約しない
  const truncated = truncateOldToolResults(history, keepRecentTurns);
  if (truncated > 0 && estimateTokens(history) < threshold) return true;

  const split = findCompactionSplit(history, keepRecentTurns);
  if (split <= 0) return truncated > 0;

  const head = history.slice(0, split);
  const rawSummary = await summarize(provider, head, opts.signal ?? new AbortController().signal);
  if (rawSummary === '') return truncated > 0; // 要約に失敗したら置換しない(生ログを保持)

  // 「## 記憶へ退避」はMYCODEX.md側へ逃がし、履歴に残す要約からは外す
  const [summary, escaped] = splitMemoryEscape(rawSummary);
  if (escaped !== null && opts.onMemoryEscape) {
    try {
      opts.onMemoryEscape(escaped);
    } catch {
      // 記憶退避の失敗で圧縮自体は止めない(要約には別途保持されている前提)
    }
  }

  const summaryPair: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `【これまでの会話の要約】\n${summary}` }] },
    { role: 'assistant', content: [{ type: 'text', text: '要約を把握しました。この文脈を踏まえて続けます。' }] },
  ];
  history.splice(0, split, ...summaryPair);
  return true;
}
