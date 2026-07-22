import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/** keywords 省略時に使う既定の関連語(AMA-teras 系) */
export const DEFAULT_KEYWORDS: readonly string[] = ['AMA-teras', 'amateras', 'アマテラス'];

/**
 * 「接触しない方がよい」兆候を拾うヒューリスティック。
 * スパム的接触の回避が目的なので、誤検出より見落としを減らす方向で広めに拾う。
 */
export const RISK_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: '営業・勧誘', pattern: /営業|勧誘|セールス|宣伝|DM.{0,8}(ください|歓迎)/i },
  { label: '金銭・投資話', pattern: /副業|稼げる|稼ごう|投資|FX|バイナリ|仮想通貨|暗号資産|エアドロ|giveaway/i },
  { label: 'フォロー稼ぎ', pattern: /相互フォロー|フォロバ|フォロー(募集|返します|返し)|f4f/i },
  { label: '外部誘導', pattern: /LINE(追加|交換|ID)|公式ライン|プロフ(ィール)?の?リンク|リンクから|アフィリエイト/i },
  { label: 'アダルト・出会い系', pattern: /18禁|成人向け|🔞|出会い(系|募集)/i },
];

/** 注記が100字に満たないときに足す定型の注意文 */
export const PADDING_SENTENCES: readonly string[] = [
  '一致語は参考情報であり、文脈の確認が前提となる。',
  '読む価値のある相手かどうか、最新の投稿もあわせて人間が確認するとよい。',
  '最終的な接触可否の判断は人間が行うこと。',
];

export interface TextSource {
  where: string;
  text: string;
}

export interface KeywordMatch {
  keyword: string;
  where: string;
  excerpt: string;
}

export type Recommendation = 'contact_ok' | 'caution' | 'weak_relation';

export interface CandidateInfo {
  account: string;
  profile?: string;
  posts?: readonly string[];
  keywords?: readonly string[];
  minLen?: number;
  maxLen?: number;
}

export interface ReasonNote {
  account: string;
  note: string;
  matches: KeywordMatch[];
  riskFlags: string[];
  recommendation: Recommendation;
}

/** text 内 index 付近を半径 radius で切り出し、根拠箇所の抜粋を作る */
export function excerptAround(text: string, index: number, length: number, radius = 18): string {
  if (text === '' || index < 0 || index >= text.length) return '';
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + Math.max(1, length) + radius);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return head + text.slice(start, end).replace(/\s+/g, ' ').trim() + tail;
}

/** 各関連語について最初に一致した出所を1件だけ拾う(大文字小文字は無視) */
export function findKeywordMatches(
  sources: readonly TextSource[],
  keywords: readonly string[],
): KeywordMatch[] {
  const matches: KeywordMatch[] = [];
  const seen = new Set<string>();
  for (const raw of keywords) {
    const keyword = raw.trim();
    if (keyword === '') continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const src of sources) {
      const idx = src.text.toLowerCase().indexOf(key);
      if (idx >= 0) {
        matches.push({ keyword, where: src.where, excerpt: excerptAround(src.text, idx, keyword.length) });
        break;
      }
    }
  }
  return matches;
}

/** テキスト群から「接触注意」の兆候ラベルを列挙する */
export function findRiskFlags(texts: readonly string[]): string[] {
  const flags: string[] = [];
  for (const { label, pattern } of RISK_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) flags.push(label);
  }
  return flags;
}

/** 注記を [minLen, maxLen] に収める。長すぎれば文境界で切り、短ければ定型文で補う */
export function fitNoteLength(
  note: string,
  minLen: number,
  maxLen: number,
  paddings: readonly string[],
): string {
  let out = note;
  if (out.length > maxLen) {
    const cut = out.lastIndexOf('。', maxLen - 1);
    out = cut >= minLen - 1 ? out.slice(0, cut + 1) : `${out.slice(0, maxLen - 1)}…`;
  }
  let guard = 0;
  while (out.length < minLen && guard < 20) {
    const pad = paddings[guard % paddings.length] ?? '';
    if (pad === '' || out.length + pad.length > maxLen) break;
    out += pad;
    guard += 1;
  }
  return out;
}

/** 候補情報から100〜200字の「発見の理由」注記を組み立てる(純関数・決定論的) */
export function buildReasonNote(candidate: CandidateInfo): ReasonNote {
  const minLen = candidate.minLen ?? 100;
  const maxLen = candidate.maxLen ?? 200;
  const keywords =
    candidate.keywords !== undefined && candidate.keywords.length > 0
      ? candidate.keywords
      : DEFAULT_KEYWORDS;

  const sources: TextSource[] = [];
  if (typeof candidate.profile === 'string' && candidate.profile.trim() !== '') {
    sources.push({ where: 'プロフィール', text: candidate.profile });
  }
  (candidate.posts ?? []).forEach((text, i) => {
    if (text.trim() !== '') sources.push({ where: `投稿${i + 1}`, text });
  });

  const matches = findKeywordMatches(sources, keywords);
  const riskFlags = findRiskFlags(sources.map((s) => s.text));

  const uniqWhere = [...new Set(matches.map((m) => m.where))];
  const matchPart =
    matches.length > 0
      ? `関連語「${matches.map((m) => m.keyword).join('」「')}」が${uniqWhere.join('・')}に一致`
      : '関連語はプロフィール・投稿に直接一致せず';
  const firstEvidence = matches.find((m) => m.where.startsWith('投稿')) ?? matches[0];
  const evidencePart =
    firstEvidence !== undefined && firstEvidence.excerpt !== ''
      ? `根拠は${firstEvidence.where}の「${firstEvidence.excerpt}」。`
      : '';
  const riskPart =
    riskFlags.length > 0
      ? `接触注意: ${riskFlags.join('・')}の兆候を検出。スパム的接触を避け、人間が内容を確認してから判断すること。`
      : '接触を妨げる兆候は検出されなかった。';

  const note = fitNoteLength(`${matchPart}。${evidencePart}${riskPart}`, minLen, maxLen, PADDING_SENTENCES);
  const recommendation: Recommendation =
    riskFlags.length > 0 ? 'caution' : matches.length === 0 ? 'weak_relation' : 'contact_ok';
  return { account: candidate.account, note, matches, riskFlags, recommendation };
}

export default {
  name: 'candidate_reason',
  description:
    '候補アカウントに「発見の理由」を100〜200字の日本語で添える(神議/uzume-patrol の候補精査用)。' +
    'account・profile・最近のposts・関連語keywords(省略時はAMA-teras系既定語)を受け取り、' +
    '(1)どの関連語がプロフィール/どの投稿に一致したか(根拠箇所の抜粋付き)、' +
    '(2)接触を避けた方がよい兆候(営業・勧誘/金銭・投資話/フォロー稼ぎ/外部誘導/アダルト等のヒューリスティック検出)、' +
    'をまとめた短い注記と、接触可否の目安(contact_ok/caution/weak_relation)を返す。' +
    'LLM不要の決定論的処理。注記は参考情報であり、最終的な接触判断は人間が行うこと。',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', description: '候補アカウント名(例: "@foo")。必須' },
      profile: { type: 'string', description: 'プロフィール/自己紹介文(省略可)' },
      posts: {
        type: 'array',
        items: { type: 'string' },
        description: '最近の投稿本文の配列(省略可)。根拠箇所の特定に使う',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'AMA-teras関連とみなす語の配列。省略時は既定語(AMA-teras / amateras / アマテラス)',
      },
    },
    required: ['account'],
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

    const account = obj.account;
    if (typeof account !== 'string' || account.trim() === '') {
      return { content: 'account(候補アカウント名)は必須の文字列で指定すること', isError: true };
    }
    const profile = obj.profile;
    if (profile !== undefined && typeof profile !== 'string') {
      return { content: 'profile は文字列で指定すること', isError: true };
    }
    let posts: string[] | undefined;
    if (obj.posts !== undefined) {
      if (!Array.isArray(obj.posts) || !obj.posts.every((p): p is string => typeof p === 'string')) {
        return { content: 'posts は文字列の配列で指定すること', isError: true };
      }
      posts = obj.posts;
    }
    let keywords: string[] | undefined;
    if (obj.keywords !== undefined) {
      if (!Array.isArray(obj.keywords) || !obj.keywords.every((k): k is string => typeof k === 'string')) {
        return { content: 'keywords は文字列の配列で指定すること', isError: true };
      }
      keywords = obj.keywords;
    }

    const result = buildReasonNote({ account: account.trim(), profile, posts, keywords });
    const matchLine =
      result.matches.length > 0
        ? result.matches.map((m) => `「${m.keyword}」(${m.where})`).join('、')
        : 'なし';
    const recLabel =
      result.recommendation === 'contact_ok'
        ? '接触候補として妥当(最終判断は人間)'
        : result.recommendation === 'caution'
          ? '接触は慎重に — 要注意の兆候あり(人間の確認必須)'
          : '関連が薄い可能性 — 接触は様子見推奨';
    return {
      content:
        `候補 ${result.account} の発見理由(${result.note.length}字):\n${result.note}\n` +
        `--- 内訳 ---\n` +
        `一致した関連語: ${matchLine}\n` +
        `接触注意の兆候: ${result.riskFlags.length > 0 ? result.riskFlags.join('・') : 'なし'}\n` +
        `判定: ${recLabel}`,
    };
  },
} satisfies ToolPlugin;
