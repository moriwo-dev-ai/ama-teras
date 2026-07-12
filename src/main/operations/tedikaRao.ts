import { randomUUID } from 'node:crypto';
import type { TriageCard, TriageFinding } from '../../shared/types';
import type { ProjectProfile } from '../../shared/types';
import type { GithubIssueSummary, GithubReader } from './adapters/github';
import { extractJson } from './llm';

/**
 * M32-5: TEDIKA-rao(タヂカラオ)— 門番。Issue/PRのトリアージカード生成。
 * 提示まで(実行=コメント/ラベル/マージは岩戸ゲート経由のみ)。
 * LLM実行は manager から注入(reviewer帯)。
 */

export function buildTriagePrompt(item: GithubIssueSummary, diff: string | null, project?: ProjectProfile): string {
  return `あなたはOSSプロジェクト ${project?.name ?? 'このプロジェクト'}${project?.description !== undefined ? '(' + project.description + ')' : ''} の門番(タヂカラオ)。以下の${item.kind === 'pr' ? 'Pull Request' : 'Issue'}をトリアージする。

# 対象
#${item.number} ${item.title}(by @${item.author})
既存ラベル: ${item.labels.join(', ') || 'なし'}

# 本文
${item.body || '(本文なし)'}
${
  diff !== null
    ? `
# diff
\`\`\`
${diff}
\`\`\`
`
    : ''
}

# severity基準(既存レビュー方式と同じ)
- high: マージ/対応するとバグ・セキュリティ問題・設計破壊を持ち込む(聖域への変更・承認バイパス・秘密情報を含むPRは必ずhigh)
- medium: 動くが品質・保守性に問題
- low: 軽微(スタイル・提案)

# 出力(JSONのみ)
{
 "summary": "要旨を2〜3文で",
 "findings": [{"severity":"high|medium|low","note":"指摘"}],
 "replyDraft": "投稿者への返信下書き(日本語。感謝→要旨確認→次のステップ。英語Issueなら英語で)",
 "labels": ["付与すべきラベル案(bug/enhancement/question/registry等)"],
 "recommendation": "推奨アクション1文(例: high解消までマージ不可 / 軽微なので即マージ可 / 情報不足のため質問返し)"
}`;
}

export function parseTriage(
  raw: string,
  repo: string,
  item: GithubIssueSummary,
): TriageCard | null {
  const parsed = extractJson(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const findings: TriageFinding[] = Array.isArray(rec['findings'])
    ? (rec['findings'] as unknown[])
        .map((f) => {
          const fr = f as Record<string, unknown>;
          const severity = fr['severity'];
          if (severity !== 'high' && severity !== 'medium' && severity !== 'low') return null;
          return { severity, note: String(fr['note'] ?? '') };
        })
        .filter((f): f is TriageFinding => f !== null)
    : [];
  return {
    id: randomUUID(),
    repo,
    kind: item.kind,
    number: item.number,
    title: item.title,
    author: item.author,
    summary: String(rec['summary'] ?? '').trim(),
    findings,
    replyDraft: String(rec['replyDraft'] ?? '').trim(),
    labels: Array.isArray(rec['labels']) ? (rec['labels'] as unknown[]).map(String) : [],
    recommendation: String(rec['recommendation'] ?? '').trim(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * リポジトリのオープンIssue/PRをトリアージ(上限つき)。
 * llm はプロンプト→テキストの関数として注入(テストではモック)。
 */
export async function triageRepo(
  repo: string,
  reader: GithubReader,
  llm: (prompt: string) => Promise<string>,
  options: { maxItems?: number; withCi?: boolean; project?: ProjectProfile } = {},
): Promise<TriageCard[]> {
  const maxItems = options.maxItems ?? 10;
  const items = (await reader.openItems(repo)).slice(0, maxItems);
  const cards: TriageCard[] = [];
  for (const item of items) {
    const diff = item.kind === 'pr' ? await reader.prDiff(repo, item.number) : null;
    let card: TriageCard | null = null;
    try {
      card = parseTriage(await llm(buildTriagePrompt(item, diff, options.project)), repo, item);
    } catch {
      card = null;
    }
    if (card === null) {
      // LLM失敗でもカード自体は出す(要旨なし。人間が原文を見に行ける)
      card = {
        id: randomUUID(),
        repo,
        kind: item.kind,
        number: item.number,
        title: item.title,
        author: item.author,
        summary: '(自動トリアージ失敗。原文を確認してください)',
        findings: [],
        replyDraft: '',
        labels: [],
        recommendation: '手動確認',
        createdAt: new Date().toISOString(),
      };
    }
    if (item.kind === 'pr' && options.withCi === true) {
      card.ci = await reader.checkRuns(repo, item.number).catch(() => []);
    }
    cards.push(card);
  }
  return cards;
}
