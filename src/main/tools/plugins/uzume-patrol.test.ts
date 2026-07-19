import { describe, expect, it } from 'vitest';
import uzumePatrol, { buildDiscoveryCandidates, formatDiscoveryInbox, parseUzumePatrolInput } from './uzume-patrol';
import type { ToolContext } from '../types';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

const primaryInfo = [
  {
    title: 'AMA-teras 岩戸ゲート仕様',
    url: 'https://example.test/amateras/iwato',
    summary: '外部コメントや承認が必要な操作は岩戸ゲートで人間承認する',
    keywords: ['岩戸ゲート', '人間承認', '外部コメント', '承認'],
  },
  {
    title: 'AMA-teras メモリ運用ガイド',
    url: 'https://example.test/amateras/memory',
    summary: 'AMA-terasの記憶、受け箱、一次情報の扱い',
    keywords: ['メモリ', '受け箱', '一次情報'],
  },
];

const items = [
  {
    url: 'https://social.example/1',
    context: 'AMA-terasの外部コメントを自動化したいが、人間承認や岩戸ゲートの考え方を知りたい。公式の一次情報を探している。',
  },
  {
    url: 'https://social.example/2',
    context: 'AMA-terasのメモリと受け箱の使い方で悩んでいる。一次情報のガイドはある？',
  },
  {
    url: 'https://social.example/3',
    context: '今日は昼ごはんがおいしかった。',
  },
  {
    url: 'https://social.example/4',
    context: '拡散希望 プレゼント企画 相互フォロー 無料で稼ぐ AMA-teras',
  },
  {
    url: 'https://social.example/5',
    context: '外部コメントの承認フローを比較したい。岩戸ゲートの根拠を教えてほしい。',
  },
  {
    url: 'https://social.example/6',
    context: '人間承認が必要な操作の使い方を知りたい。外部コメントの公式情報はどこ？',
  },
];

describe('uzume-patrol', () => {
  it('一次情報が役立ちそうな会話だけを最大3件の発見候補にする', () => {
    const candidates = buildDiscoveryCandidates({ items, primaryInfo });
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.url)).not.toContain('https://social.example/3');
    expect(candidates.map((candidate) => candidate.url)).not.toContain('https://social.example/4');
    expect(candidates[0]?.relatedPrimaryInfo.url).toMatch(/^https:\/\/example\.test\/amateras\//);
    expect(candidates[0]?.relevance).toContain('一次情報');
    expect(candidates[0]?.noReplyReason).toContain('自動返信案ではない');
  });

  it('formatDiscoveryInbox は返信案を出さず、URL・文脈・関係理由・返信しない理由を含める', () => {
    const candidates = buildDiscoveryCandidates({ items: items.slice(0, 2), primaryInfo });
    const content = formatDiscoveryInbox(candidates);
    expect(content).toContain('返信案は生成していません');
    expect(content).toContain('外部コメントは引き続き人間承認と岩戸ゲート必須');
    expect(content).toContain('https://social.example/1');
    expect(content).toContain('文脈:');
    expect(content).toContain('なぜ関係するか:');
    expect(content).toContain('返信しない方がよい理由:');
    expect(content).not.toContain('返信案:');
  });

  it('候補が無い場合も自動返信案を生成しないことを明示する', () => {
    const content = formatDiscoveryInbox([]);
    expect(content).toContain('発見候補はありません');
    expect(content).toContain('自動返信案は生成していません');
  });

  it('入力を検証し、不正な型はエラー文にする', () => {
    expect(parseUzumePatrolInput({ items: 'bad', primaryInfo })).toContain('items');
    expect(parseUzumePatrolInput({ items, primaryInfo: [{ title: 1, url: 'x' }] })).toContain('primaryInfo');
    expect(parseUzumePatrolInput({ items, primaryInfo, maxCandidates: '3' })).toContain('maxCandidates');
  });

  it('execute は受け箱用の発見候補を返す', async () => {
    const r = await uzumePatrol.execute({ items, primaryInfo, maxCandidates: 2 }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('受け箱候補 2件');
    expect(r.content).toContain('返信案は生成していません');
  });

  it('execute は不正入力で isError を返す', async () => {
    const r = await uzumePatrol.execute({ items: [], primaryInfo: 'bad' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('primaryInfo');
  });
});
