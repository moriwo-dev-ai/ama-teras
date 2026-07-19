import type { ToolContext, ToolPlugin, ToolResult } from '../types';

export interface PatrolItem {
  url: string;
  context: string;
  title?: string;
  source?: string;
  author?: string;
}

export interface PrimaryInfo {
  title: string;
  url: string;
  summary?: string;
  keywords?: string[];
}

export interface UzumePatrolInput {
  items: PatrolItem[];
  primaryInfo: PrimaryInfo[];
  maxCandidates?: number;
  minScore?: number;
}

export interface DiscoveryCandidate {
  url: string;
  context: string;
  relatedPrimaryInfo: { title: string; url: string };
  relevance: string;
  noReplyReason: string;
  score: number;
}

const HELP_INTENT_WORDS = [
  '困って',
  '悩ん',
  '探して',
  '知りたい',
  '教えて',
  '比較',
  '導入',
  '使い方',
  '事例',
  '公式',
  '一次情報',
  '根拠',
];

const LOW_QUALITY_WORDS = ['相互フォロー', '拡散希望', 'キャンペーン', '無料で稼ぐ', '副業で月', 'プレゼント企画'];

const STOP_WORDS = new Set([
  'これ',
  'それ',
  'ため',
  'こと',
  'もの',
  'さん',
  'です',
  'ます',
  'する',
  'した',
  'ある',
  'いる',
  'about',
  'with',
  'from',
  'this',
  'that',
  'the',
  'and',
  'for',
]);

function hasObjectShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPatrolItem(value: unknown): value is PatrolItem {
  if (!hasObjectShape(value)) {
    return false;
  }
  if (typeof value.url !== 'string' || typeof value.context !== 'string') {
    return false;
  }
  return (
    (value.title === undefined || typeof value.title === 'string') &&
    (value.source === undefined || typeof value.source === 'string') &&
    (value.author === undefined || typeof value.author === 'string')
  );
}

function isPrimaryInfo(value: unknown): value is PrimaryInfo {
  if (!hasObjectShape(value)) {
    return false;
  }
  if (typeof value.title !== 'string' || typeof value.url !== 'string') {
    return false;
  }
  return (
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.keywords === undefined || isStringArray(value.keywords))
  );
}

export function parseUzumePatrolInput(input: unknown): UzumePatrolInput | string {
  if (!hasObjectShape(input)) {
    return '入力は object で指定すること';
  }
  if (!Array.isArray(input.items) || !input.items.every(isPatrolItem)) {
    return 'items は { url, context, title?, source?, author? } の配列で指定すること';
  }
  if (!Array.isArray(input.primaryInfo) || !input.primaryInfo.every(isPrimaryInfo)) {
    return 'primaryInfo は { title, url, summary?, keywords? } の配列で指定すること';
  }
  if (input.maxCandidates !== undefined && (typeof input.maxCandidates !== 'number' || !Number.isFinite(input.maxCandidates))) {
    return 'maxCandidates は数値で指定すること';
  }
  if (input.minScore !== undefined && (typeof input.minScore !== 'number' || !Number.isFinite(input.minScore))) {
    return 'minScore は数値で指定すること';
  }
  return {
    items: input.items,
    primaryInfo: input.primaryInfo,
    maxCandidates: typeof input.maxCandidates === 'number' ? input.maxCandidates : undefined,
    minScore: typeof input.minScore === 'number' ? input.minScore : undefined,
  };
}

export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_一-龠ぁ-んァ-ヶー]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 30);
}

function primaryKeywords(info: PrimaryInfo): string[] {
  const explicit = info.keywords ?? [];
  const generated = extractKeywords(`${info.title} ${info.summary ?? ''}`);
  return [...new Set([...explicit.map((word) => word.toLowerCase()), ...generated])].filter((word) => word.length >= 2);
}

function countMatches(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
}

function helpIntentScore(text: string): number {
  return HELP_INTENT_WORDS.filter((word) => text.includes(word)).length;
}

function lowQualityPenalty(text: string): number {
  return LOW_QUALITY_WORDS.filter((word) => text.includes(word)).length * 3;
}

function summarizeContext(item: PatrolItem): string {
  const title = item.title !== undefined && item.title.trim() !== '' ? `「${item.title.trim()}」 ` : '';
  const source = item.source !== undefined && item.source.trim() !== '' ? `(${item.source.trim()}) ` : '';
  const author = item.author !== undefined && item.author.trim() !== '' ? `@${item.author.trim()} ` : '';
  const body = item.context.trim().replace(/\s+/g, ' ');
  return `${source}${author}${title}${body}`.slice(0, 420);
}

export function buildDiscoveryCandidates(input: UzumePatrolInput): DiscoveryCandidate[] {
  const limit = Math.max(0, Math.min(3, Math.floor(input.maxCandidates ?? 3)));
  const minScore = input.minScore ?? 2;
  if (limit === 0 || input.primaryInfo.length === 0) {
    return [];
  }

  const scored: DiscoveryCandidate[] = [];
  for (const item of input.items) {
    const text = `${item.title ?? ''} ${item.context}`;
    let bestInfo: PrimaryInfo | undefined;
    let bestMatches: string[] = [];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const info of input.primaryInfo) {
      const matches = countMatches(text, primaryKeywords(info));
      const score = matches.length * 2 + helpIntentScore(text) - lowQualityPenalty(text);
      if (score > bestScore) {
        bestScore = score;
        bestInfo = info;
        bestMatches = matches;
      }
    }

    if (bestInfo === undefined || bestScore < minScore) {
      continue;
    }

    const matchText = bestMatches.length > 0 ? `一致語: ${bestMatches.slice(0, 6).join(' / ')}` : '明示的な一致語は少ないが相談意図がある';
    scored.push({
      url: item.url,
      context: summarizeContext(item),
      relatedPrimaryInfo: { title: bestInfo.title, url: bestInfo.url },
      relevance: `AMA-teras一次情報「${bestInfo.title}」が、投稿内の課題確認に役立つ可能性がある。${matchText}。`,
      noReplyReason:
        'この出力は発見候補の受け箱投入だけを目的とし、自動返信案ではない。外部コメントは人間承認と岩戸ゲートを通すまで行わない方がよい。',
      score: bestScore,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit);
}

export function formatDiscoveryInbox(candidates: DiscoveryCandidate[]): string {
  if (candidates.length === 0) {
    return 'uzume-patrol: 受け箱に入れる発見候補はありません。自動返信案は生成していません。';
  }

  const lines = [
    `uzume-patrol: 受け箱候補 ${candidates.length}件（最大3件）。返信案は生成していません。`,
    '外部コメントは引き続き人間承認と岩戸ゲート必須です。',
  ];
  candidates.forEach((candidate, index) => {
    lines.push(
      '',
      `${index + 1}. ${candidate.url}`,
      `文脈: ${candidate.context}`,
      `関係する一次情報: ${candidate.relatedPrimaryInfo.title} - ${candidate.relatedPrimaryInfo.url}`,
      `なぜ関係するか: ${candidate.relevance}`,
      `返信しない方がよい理由: ${candidate.noReplyReason}`,
    );
  });
  return lines.join('\n');
}

export default {
  name: 'uzume-patrol',
  description:
    '巡回で見つけた投稿・記事から、AMA-terasの一次情報が本当に役立ちそうな会話だけを最大3件選び、' +
    'URL・文脈・関係理由・返信しない理由を受け箱向けに出す。自動返信案は生成しない。',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '巡回で見つけた投稿・記事。各要素は url と context が必須。',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            context: { type: 'string' },
            title: { type: 'string' },
            source: { type: 'string' },
            author: { type: 'string' },
          },
          required: ['url', 'context'],
        },
      },
      primaryInfo: {
        type: 'array',
        description: 'AMA-terasの一次情報。title/url必須、summary/keywords任意。',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            summary: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'url'],
        },
      },
      maxCandidates: { type: 'number', description: '出力件数。指定しても最大3件に制限される。省略=3。' },
      minScore: { type: 'number', description: '候補採用の最低スコア。省略=2。' },
    },
    required: ['items', 'primaryInfo'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  warnings: ['自動返信案は生成しない。外部コメントは人間承認と岩戸ゲート必須。'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseUzumePatrolInput(input);
    if (typeof parsed === 'string') {
      return { content: parsed, isError: true };
    }
    return { content: formatDiscoveryInbox(buildDiscoveryCandidates(parsed)) };
  },
} satisfies ToolPlugin;
