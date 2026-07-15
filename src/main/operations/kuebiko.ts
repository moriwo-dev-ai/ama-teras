import type { GithubIssueSummary } from './adapters/github';

/**
 * M91-4: KUEBIKO(久延毘古)— 要望のトリアージ。
 *
 * 久延毘古は「歩けないが、世の中のことを何でも知っている」神(古事記)。
 * 動き回って発信する神ではなく、**集まってくる声を知っている**神。要望チャネル
 * (request:core / request:ui のIssue)を見張り、重複を潰し、効き目の順に並べて
 * 神議の承認カードへ載せる役はこれが合う。
 *
 * ※ 手力男(TEDIKA-rao)は既に「門番」(issue-gatekeeper)として居る。同じ神を2度立てない。
 *
 * ここは純関数だけ(LLM呼び出し・GitHubアクセスは manager が持つ)。
 * 承認されると本体(core/renderer)の進化ジョブになる = **開発機でしか走らない**。
 * 配布版のユーザーが出した要望が、開発機で拾われて本体に入り、配布版へ戻る — その一周を作る
 */

export const REQUEST_LABELS = ['request:core', 'request:ui'] as const;

export interface RequestItem {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  scope: 'core' | 'renderer';
}

/**
 * 要望のIssueを拾い、種別を判定する(PRは対象外。要望はIssueで来る)。
 *
 * 種別は **ラベル または 本文の機械マーカー** で見る。理由: GitHubは非コラボレータが立てた
 * Issueのラベルを剥がすので、外部貢献者の要望はラベルが付かない。アプリが本文に残す
 * `<!-- amateras-request:ui -->` マーカーを主判定にすることで、外部の要望も取りこぼさない
 */
function requestKind(i: GithubIssueSummary): 'core' | 'renderer' | null {
  const core = i.labels.includes('request:core') || /amateras-request:\s*core/i.test(i.body);
  const ui = i.labels.includes('request:ui') || /amateras-request:\s*ui/i.test(i.body);
  // 両方該当したら重い方(core)に寄せる。過小評価より過大評価のほうが安全
  if (core) return 'core';
  if (ui) return 'renderer';
  return null;
}

export function selectRequests(repo: string, items: GithubIssueSummary[]): RequestItem[] {
  return items
    .filter((i) => i.kind === 'issue')
    .flatMap((i) => {
      const scope = requestKind(i);
      if (scope === null) return [];
      return [{ repo, number: i.number, title: i.title, body: i.body, author: i.author, scope }];
    });
}

export interface RankedRequest {
  number: number;
  impact: number;
  effort: number;
  rationale: string;
  duplicateOf?: number;
}

export function buildRankPrompt(items: RequestItem[]): string {
  const list = items
    .map((i) => `- #${i.number} [${i.scope}] ${i.title}\n  ${i.body.slice(0, 400).replace(/\n/g, ' ')}`)
    .join('\n');
  return [
    'あなたはAMA-terasの要望トリアージ担当。以下は利用者(と、利用者のAMA-teras自身)から届いた',
    '本体(コア/UI)への要望です。実装する順番を決めるため、1件ずつ評価してください。',
    '',
    list,
    '',
    '評価の観点:',
    '- impact(1〜5): 直したときに効く人数×効き目。「今できないことができるようになる」ほど高い',
    '- effort(1〜5): 実装の重さ。小さいほど低い',
    '- duplicate_of: 上の一覧の中に実質同じ要望があれば、その番号(なければ省略)',
    '',
    '出力は次のJSONだけ(説明文を付けない):',
    '```json',
    '{"ranked":[{"number":123,"impact":4,"effort":2,"rationale":"…","duplicate_of":null}]}',
    '```',
  ].join('\n');
}

/** LLM応答からランキングを取り出す(壊れた応答は空配列 = 何も提案しない) */
export function parseRanking(text: string): RankedRequest[] {
  const m = /```json\s*([\s\S]*?)```/.exec(text) ?? /(\{[\s\S]*\})/.exec(text);
  if (m === null) return [];
  try {
    const raw: unknown = JSON.parse(m[1]!);
    const rec = raw as { ranked?: unknown };
    if (!Array.isArray(rec.ranked)) return [];
    return rec.ranked.flatMap((r): RankedRequest[] => {
      const x = r as Record<string, unknown>;
      const number = typeof x['number'] === 'number' ? x['number'] : Number.NaN;
      if (!Number.isFinite(number)) return [];
      const clamp = (v: unknown): number => {
        const n = typeof v === 'number' ? v : Number.NaN;
        return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 3;
      };
      const dup = x['duplicate_of'];
      return [
        {
          number,
          impact: clamp(x['impact']),
          effort: clamp(x['effort']),
          rationale: String(x['rationale'] ?? '').slice(0, 300),
          ...(typeof dup === 'number' && Number.isFinite(dup) ? { duplicateOf: dup } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * 効き目の順に並べる。重複(duplicateOf)は落とす。
 * 順位は impact を主、effort を従(同じ効き目なら軽いものが先)
 */
export function rankRequests(items: RequestItem[], ranked: RankedRequest[]): { item: RequestItem; rank: RankedRequest }[] {
  const byNumber = new Map(items.map((i) => [i.number, i]));
  return ranked
    .filter((r) => r.duplicateOf === undefined && byNumber.has(r.number))
    .sort((a, b) => b.impact - a.impact || a.effort - b.effort || a.number - b.number)
    .map((r) => ({ item: byNumber.get(r.number)!, rank: r }));
}

/** 承認カードの本文(人間が読んで「やる/やらない」を決められるだけの情報を載せる) */
export function proposalDetail(item: RequestItem, rank: RankedRequest): string {
  return [
    `出どころ: ${item.repo}#${item.number}(${item.author})`,
    `効き目 ${rank.impact}/5 ・ 重さ ${rank.effort}/5`,
    `判断: ${rank.rationale}`,
    '',
    item.body.slice(0, 800),
    '',
    `承認すると scope=${item.scope} の進化ジョブとして起票する(生成物の昇格は、いつもどおり別途あなたの承認を通る)`,
  ].join('\n');
}
