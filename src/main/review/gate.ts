import type {
  ReviewCardPayload,
  ReviewFinding,
  ReviewGateConfig,
  ReviewScores,
} from '../../shared/types';
import { runAgentLoop } from '../agent/loop';
import type { ChatMessage, LLMProvider } from '../providers/types';
import { isLocalHost } from '../tools/plugins/screenshot';
import type { ToolContext, ToolPlugin, ToolResult } from '../tools/types';

/**
 * M19: 品質レビュー・ゲート。planner帯の「辛口レビュアー」エージェントが成果物を
 * 4軸(code/ux/requirements/tests)で採点し、閾値未満なら具体指摘つきで差し戻す。
 * - レビュアーは読み取り専用ツール(+localhost限定screenshot)のみ。書き換え不可
 * - レビュー自体の失敗(JSONパース不能・LLMエラー)はタスクを壊さない(素通し+警告)
 * - electron 非依存(プロバイダ・ツール・fix実行は注入)でユニットテスト可能
 */

export interface ReviewTarget {
  /** レビュー対象(完了したマイルストーン項目 or「完成時レビュー」) */
  milestone: string;
  /** 元のユーザー依頼(今回の送信テキスト) */
  userRequest: string;
  /** 現在の計画ファイル全文(無ければ空) */
  planContent: string;
}

export interface ReviewerDeps {
  provider: LLMProvider;
  tools: { list(): ToolPlugin[]; get(name: string): ToolPlugin | undefined };
  cwd: string;
  axes: ReviewGateConfig['axes'];
  threshold: number;
  /** M14 screenshot の注入。あれば ux 軸でUIを自己確認できる(localhost限定) */
  captureUrl?: (url: string, width?: number, height?: number) => Promise<{ data: string; mediaType: string }>;
  maxTurns?: number;
}

/** レビュアーに見せてよいツール: 読み取り専用 + screenshot(captureUrl注入時のみ) */
function isReviewerTool(p: ToolPlugin, allowScreenshot: boolean): boolean {
  if (p.name === 'screenshot') return allowScreenshot;
  return (
    p.risk === 'safe' &&
    p.name !== 'request_capability' &&
    p.name !== 'dispatch_agent' &&
    p.name !== 'plan' &&
    p.name !== 'memory' &&
    !p.name.startsWith('mcp__')
  );
}

const REVIEWER_PROMPT = (t: ReviewTarget, axes: ReviewGateConfig['axes'], threshold: number): string => {
  const axisLines = [
    axes.code ? '- code: コード品質(可読性・設計・重複・命名・エラー処理・エッジケース)' : null,
    axes.ux
      ? '- ux: 見た目/UX。Web/GUI成果物のときだけ採点(screenshotツールがあれば localhost のUIを実際に確認)。UIが無いタスクでは必ず null にする'
      : null,
    axes.requirements ? '- requirements: 元の依頼と計画項目を漏れなく満たしているか' : null,
    axes.tests ? '- tests: テストの質(通るだけでなくカバレッジ・意味のあるケース・異常系)' : null,
  ].filter((s): s is string => s !== null);

  return `あなたは第三者の辛口コードレビュアー。この成果物を自分が書いた・レビューしたという前提を一切持たず、初見の厳しい目で採点する。甘い点数をつけないこと。

# レビュー対象
マイルストーン: ${t.milestone}

# 元のユーザー依頼
${t.userRequest.slice(0, 2000)}

# 現在の計画(AMATERAS_PLAN.md)
${t.planContent.trim() === '' ? '(計画ファイルなし)' : t.planContent.slice(0, 4000)}

# 手順
read_file / list_dir / grep で成果物のコードとテストを実際に読んで確認する(推測で採点しない)。

# 採点軸(各1〜5。5=文句なし、4=軽微な改善余地、3=明確な問題あり、2以下=重大)
${axisLines.join('\n')}

# 出力(最重要)
確認が済んだら、最後の応答で必ず次のJSONを \`\`\`json フェンスで1つだけ出力する:
\`\`\`json
{"scores":{"code":4,"ux":null,"requirements":5,"tests":3},"findings":[{"file":"src/app.mjs","location":"createApp() のPUTハンドラ","problem":"存在しないidでも200を返す","fix":"db.get で存在確認し無ければ404を返す"}],"summary":"1〜2文の総評"}
\`\`\`
- 対象外の軸は null(勝手に軸を増やさない)
- findings は具体的に: file(ファイルパス)/ location(関数名・行の目安)/ problem(何が問題か)/ fix(どう直すか)の4つ全部を書く。「全体的に改善」のような抽象指摘は禁止
- 合格閾値は平均 ${threshold}。閾値未満になりそうな問題は必ず findings に挙げる`;
};

/** レビュアーの最終テキストからJSONを取り出す(フェンス優先→最後の{}) */
export function parseReviewOutput(
  text: string,
  axes: ReviewGateConfig['axes'],
): { scores: ReviewScores; findings: ReviewFinding[]; summary: string } | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = fenced.length > 0 ? fenced.reverse() : [];
  // フェンスが無い場合は最後の { から末尾までを候補にする(粗いが実用上十分)
  if (candidates.length === 0) {
    const idx = text.lastIndexOf('{"scores"');
    if (idx >= 0) candidates.push(text.slice(idx));
  }
  for (const raw of candidates) {
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      if (typeof parsed !== 'object' || parsed === null) continue;
      const rec = parsed as Record<string, unknown>;
      const scoresRec =
        typeof rec['scores'] === 'object' && rec['scores'] !== null
          ? (rec['scores'] as Record<string, unknown>)
          : null;
      if (!scoresRec) continue;
      const clamp = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : null;
      const scores: ReviewScores = {
        code: axes.code ? clamp(scoresRec['code']) : null,
        ux: axes.ux ? clamp(scoresRec['ux']) : null,
        requirements: axes.requirements ? clamp(scoresRec['requirements']) : null,
        tests: axes.tests ? clamp(scoresRec['tests']) : null,
      };
      if (Object.values(scores).every((s) => s === null)) continue; // 全軸nullは採点になっていない
      const findings: ReviewFinding[] = Array.isArray(rec['findings'])
        ? rec['findings']
            .map((f): ReviewFinding | null => {
              const r = typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : null;
              if (!r) return null;
              const file = r['file'];
              const location = r['location'];
              const problem = r['problem'];
              const fix = r['fix'];
              // 抽象指摘の機械的排除: 4フィールド全部が非空文字列のものだけ採用
              if (
                typeof file !== 'string' || file.trim() === '' ||
                typeof location !== 'string' || location.trim() === '' ||
                typeof problem !== 'string' || problem.trim() === '' ||
                typeof fix !== 'string' || fix.trim() === ''
              ) {
                return null;
              }
              return { file: file.trim(), location: location.trim(), problem: problem.trim(), fix: fix.trim() };
            })
            .filter((f): f is ReviewFinding => f !== null)
        : [];
      const summary = typeof rec['summary'] === 'string' ? rec['summary'] : '';
      return { scores, findings, summary };
    } catch {
      continue;
    }
  }
  return null;
}

/** 有効軸のうち非nullスコアの平均。スコアが1つも無ければ null */
export function averageScore(scores: ReviewScores): number | null {
  const vals = Object.values(scores).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

/**
 * レビュアーを1回実行する。パース不能・エラー時は null(呼び出し側が素通し+警告)。
 * screenshot は localhost 限定(executor承認フローを経由しないため、外部URLは機械拒否)
 */
export async function runReviewer(
  deps: ReviewerDeps,
  target: ReviewTarget,
  round: number,
  signal: AbortSignal,
): Promise<ReviewCardPayload | null> {
  const allowScreenshot = deps.captureUrl !== undefined && deps.axes.ux;
  const tools = deps.tools.list().filter((p) => isReviewerTool(p, allowScreenshot));
  const history: ChatMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            round === 0
              ? 'このマイルストーンの成果物をレビューして採点せよ。'
              : `差し戻し後の再レビュー(${round}回目)。前回の指摘が解消されたか重点的に確認して採点せよ。`,
        },
      ],
    },
  ];

  const status = await runAgentLoop(
    {
      provider: deps.provider,
      tools: { list: () => tools },
      executeTool: async (name, input, ctx: ToolContext): Promise<ToolResult> => {
        const plugin = deps.tools.get(name);
        if (!plugin || !isReviewerTool(plugin, allowScreenshot)) {
          return { content: `レビュアーは読み取り専用ツールのみ使用可(拒否: ${name})`, isError: true };
        }
        if (name === 'screenshot') {
          const { url } = (input ?? {}) as { url?: unknown };
          let host = '';
          try {
            host = new URL(String(url)).hostname;
          } catch {
            /* 下のexecuteでエラーになる */
          }
          if (!isLocalHost(host)) {
            return { content: 'レビューでの screenshot は localhost のみ許可', isError: true };
          }
        }
        return plugin.execute(input, {
          ...ctx,
          ...(deps.captureUrl !== undefined ? { screenshot: { capture: deps.captureUrl } } : {}),
        });
      },
      emit: () => {}, // レビュアーの生ログは親チャットへ流さない(結果はレビューカードで表示)
      systemPrompt: REVIEWER_PROMPT(target, deps.axes, deps.threshold),
      cwd: deps.cwd,
      maxTurns: deps.maxTurns ?? 15,
    },
    `review-${round}`,
    history,
    signal,
  );
  if (status === 'cancelled') return null;

  const lastText = history
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const parsed = parseReviewOutput(lastText, deps.axes);
  if (!parsed) return null;
  const average = averageScore(parsed.scores);
  if (average === null) return null;
  return {
    milestone: target.milestone,
    round,
    scores: parsed.scores,
    average,
    pass: average >= deps.threshold,
    findings: parsed.findings,
    summary: parsed.summary,
  };
}

/** worker への差し戻しタスク文(指摘リストを具体的なまま渡す) */
export function buildFixTask(target: ReviewTarget, card: ReviewCardPayload): string {
  const list = card.findings
    .map((f, i) => `${i + 1}. ${f.file}(${f.location}): ${f.problem} → 修正方法: ${f.fix}`)
    .join('\n');
  return `品質レビューで不合格(平均${card.average}/5)になった。以下の指摘を全て修正せよ。指摘以外の箇所は触らないこと。修正後、関連テストがあれば実行して通ることを確認してから、修正内容を要約して報告せよ。

対象マイルストーン: ${target.milestone}

指摘リスト:
${list.length > 0 ? list : `(具体指摘なし。総評: ${card.summary})`}`;
}

export interface ReviewCycleDeps {
  config: ReviewGateConfig;
  /** 1回のレビュー実行(round番号つき) */
  review: (round: number) => Promise<ReviewCardPayload | null>;
  /** 差し戻し修正の実行(worker帯。roundは1始まり。3回目以降はescalation帯 — 呼び出し側が束ねる) */
  fix: (card: ReviewCardPayload, round: number) => Promise<void>;
  /** 各ラウンドのカード通知(チャット表示+audit) */
  onCard: (card: ReviewCardPayload) => void;
  signal: AbortSignal;
}

export interface ReviewCycleResult {
  /** 最終カード(レビュー自体が失敗したときは null) */
  final: ReviewCardPayload | null;
  /** 実施した差し戻し(fix)回数 */
  fixRounds: number;
  /** true=合格 or レビュー不能(素通し)。false=上限到達でも閾値未満(残課題あり) */
  resolved: boolean;
  /** レビュー自体(LLM/パース)が失敗した */
  reviewFailed: boolean;
}

/** レビュー → 不合格なら fix → 再レビュー、を上限まで回す */
export async function runReviewCycle(deps: ReviewCycleDeps): Promise<ReviewCycleResult> {
  let card = await deps.review(0);
  if (card === null) return { final: null, fixRounds: 0, resolved: true, reviewFailed: true };
  deps.onCard(card);

  let fixRounds = 0;
  while (!card.pass && fixRounds < deps.config.maxRoundsPerMilestone && !deps.signal.aborted) {
    fixRounds++;
    await deps.fix(card, fixRounds);
    if (deps.signal.aborted) break;
    const next = await deps.review(fixRounds);
    if (next === null) {
      // 再レビュー不能: 直前の不合格カードを残したまま打ち切り(素通し扱いにはしない)
      return { final: card, fixRounds, resolved: false, reviewFailed: true };
    }
    card = next;
    deps.onCard(card);
  }

  return { final: card, fixRounds, resolved: card.pass, reviewFailed: false };
}
