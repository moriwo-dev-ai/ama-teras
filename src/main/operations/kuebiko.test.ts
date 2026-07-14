import { describe, expect, it } from 'vitest';
import type { GithubIssueSummary } from './adapters/github';
import { buildRankPrompt, parseRanking, proposalDetail, rankRequests, selectRequests } from './kuebiko';

/**
 * M91-4: KUEBIKO(久延毘古)。配布版の人が出した本体への要望を、開発機が拾って本体に入れ、
 * 配布版へ戻す — その一周の「拾う側」。ここが取りこぼすと、要望はIssueに沈んだままになる
 */

const issue = (over: Partial<GithubIssueSummary>): GithubIssueSummary => ({
  number: 1,
  title: 't',
  author: 'someone',
  kind: 'issue',
  body: 'b',
  labels: [],
  ...over,
});

describe('selectRequests', () => {
  it('request:core / request:ui のIssueだけを拾う', () => {
    const items = [
      issue({ number: 1, labels: ['request:ui'], title: 'UIの話' }),
      issue({ number: 2, labels: ['bug'], title: 'ただのバグ報告' }),
      issue({ number: 3, labels: ['request:core'], title: 'コアの話' }),
      issue({ number: 4, labels: ['request:core'], kind: 'pr', title: 'PRは対象外' }),
    ];
    const got = selectRequests('o/r', items);
    expect(got.map((r) => r.number)).toEqual([1, 3]);
    expect(got.map((r) => r.scope)).toEqual(['renderer', 'core']);
  });

  it('core と ui の両方が付いていたら重い方(core)に寄せる', () => {
    const got = selectRequests('o/r', [issue({ number: 5, labels: ['request:ui', 'request:core'] })]);
    expect(got[0]?.scope).toBe('core');
  });
});

describe('parseRanking / rankRequests', () => {
  const items = selectRequests('o/r', [
    issue({ number: 1, labels: ['request:ui'], title: 'A' }),
    issue({ number: 2, labels: ['request:ui'], title: 'B' }),
    issue({ number: 3, labels: ['request:core'], title: 'C' }),
  ]);

  it('効き目の順に並べ、同点なら軽い方を先に出す', () => {
    const ranked = parseRanking(
      '```json\n{"ranked":[' +
        '{"number":1,"impact":3,"effort":4,"rationale":"x"},' +
        '{"number":2,"impact":5,"effort":2,"rationale":"y"},' +
        '{"number":3,"impact":3,"effort":1,"rationale":"z"}]}\n```',
    );
    expect(rankRequests(items, ranked).map((r) => r.item.number)).toEqual([2, 3, 1]);
  });

  it('重複と判定されたものは落とす(同じ話で承認待ちを埋めない)', () => {
    const ranked = parseRanking(
      '```json\n{"ranked":[{"number":1,"impact":4,"effort":2,"rationale":"x"},' +
        '{"number":2,"impact":4,"effort":1,"rationale":"1と同じ","duplicate_of":1}]}\n```',
    );
    expect(rankRequests(items, ranked).map((r) => r.item.number)).toEqual([1]);
  });

  it('壊れた応答では何も提案しない(黙って的外れなカードを出さない)', () => {
    expect(parseRanking('すみません、判断できません')).toEqual([]);
    expect(parseRanking('```json\n{壊れ\n```')).toEqual([]);
  });

  it('一覧に無い番号は捨てる(LLMが番号を作っても提案にしない)', () => {
    const ranked = parseRanking('```json\n{"ranked":[{"number":999,"impact":5,"effort":1,"rationale":"?"}]}\n```');
    expect(rankRequests(items, ranked)).toEqual([]);
  });

  it('プロンプトには本文と番号が入る(タイトルだけでは効き目を測れない)', () => {
    const p = buildRankPrompt(items);
    expect(p).toContain('#1');
    expect(p).toContain('[core]');
  });
});

describe('proposalDetail', () => {
  it('出どころ・効き目・スコープを、人が判断できる形で載せる', () => {
    const item = selectRequests('o/r', [issue({ number: 7, labels: ['request:core'], title: 'X', body: '本文' })])[0]!;
    const text = proposalDetail(item, { number: 7, impact: 5, effort: 2, rationale: '効く' });
    expect(text).toContain('o/r#7');
    expect(text).toContain('効き目 5/5');
    expect(text).toContain('scope=core');
  });
});
