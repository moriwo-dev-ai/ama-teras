import type {
  AgentEvent,
  ApprovalDecision,
  ReviewCardPayload,
  ReviewGateConfig,
} from '../../shared/types';
import type { LLMProvider } from '../providers/types';
import type { ToolPlugin } from '../tools/types';
import { buildFixTask, runReviewCycle, runReviewer, type ReviewTarget } from './gate';

/**
 * M26-9(T9): レビューゲート連携部(1マイルストーン分のレビュー→差し戻し→再レビューの束)を
 * service.ts から機械的に抽出(挙動変更なし)。service 依存(帯プロバイダ生成・サブエージェント
 * fix実行・承認ブローカー・audit)はコールバックで注入し、electron 非依存のままにする。
 */

export interface ReviewGateStepDeps {
  /** 現在の reviewGate 設定(未設定・無効なら素通し=null を返す) */
  cfg: ReviewGateConfig | undefined;
  registry: { list(): ToolPlugin[]; get(name: string): ToolPlugin | undefined };
  /** M14 screenshot の注入(あれば ux 軸でUIを自己確認できる) */
  captureUrl?: (url: string, width?: number, height?: number) => Promise<{ data: string; mediaType: string }>;
  /** audit.jsonl への記録(tool='review-gate' の詳細行) */
  auditAppend: (detail: string) => void;
  /** reviewer帯プロバイダの生成。string=キー未登録メッセージ(planner代行の警告に使う) */
  createReviewerProvider: () => LLMProvider | string;
  /** 差し戻しfixの実行(provider は fix階段で選択済み。中身は work サブエージェント) */
  runFix: (provider: LLMProvider, task: string, signal: AbortSignal) => Promise<void>;
  /** 上限到達時の残課題許容の承認(自律モードOFFのときだけ呼ばれる) */
  requestApproval: (inputPreview: string, warning: string, signal: AbortSignal) => Promise<ApprovalDecision>;
  /** 計画ファイル(AMATERAS_PLAN.md)の読取 */
  readPlan: (workspace: string) => string;
}

export interface ReviewGateStepArgs {
  workspace: string;
  emit: (e: AgentEvent) => void;
  sessionId: string;
  milestone: string;
  userRequest: string;
  signal: AbortSignal;
  /** 会話単位の自律モード(ONなら上限到達でも承認を仰がず警告のみ) */
  autonomous: boolean;
  plannerProvider: LLMProvider;
  /**
   * M26-2: true=planner帯でレビュー(最終マイルストーン完了時・コア領域に触れた変更・
   * 進化昇格前)。false=reviewer帯(未指定なら planner 代行)で日常レビュー
   */
  forcePlannerReview: boolean;
  workerProvider: LLMProvider;
  midEscalationProvider: LLMProvider;
  escalationProvider: LLMProvider;
}

/**
 * レビューゲート1サイクル(レビュー → 不合格なら差し戻し → 再レビュー)。
 * 戻り値は plan の tool_result 等に追記する日本語の要約(無効・キャンセル時は null)
 */
export async function runReviewGateStep(
  deps: ReviewGateStepDeps,
  args: ReviewGateStepArgs,
): Promise<string | null> {
  const cfg = deps.cfg;
  if (cfg === undefined || !cfg.enabled || args.signal.aborted) return null;
  const ws = args.workspace;
  // M26-2: 日常レビューは reviewer 帯(監査役)。キー未登録は警告して planner で代行
  let reviewProvider = args.plannerProvider;
  if (!args.forcePlannerReview) {
    const r = deps.createReviewerProvider();
    if (typeof r === 'string') {
      args.emit({ kind: 'info', sessionId: args.sessionId, message: `⚠ ${r} — レビューは planner 帯で代行します` });
    } else {
      reviewProvider = r;
    }
  }
  const target: ReviewTarget = {
    milestone: args.milestone,
    userRequest: args.userRequest,
    planContent: deps.readPlan(ws),
  };
  const emitCard = (card: ReviewCardPayload): void => {
    args.emit({ kind: 'review', sessionId: args.sessionId, ...card });
    deps.auditAppend(
      `milestone="${args.milestone.slice(0, 80)}" round=${card.round} avg=${card.average} pass=${card.pass} findings=${card.findings.length}`,
    );
  };

  const result = await runReviewCycle({
    config: cfg,
    review: (round) =>
      runReviewer(
        {
          provider: reviewProvider,
          tools: deps.registry,
          cwd: ws,
          axes: cfg.axes,
          threshold: cfg.threshold,
          passMode: cfg.passMode ?? 'severity',
          ...(deps.captureUrl !== undefined ? { captureUrl: deps.captureUrl } : {}),
        },
        target,
        round,
        args.signal,
      ),
    fix: async (card, round) => {
      // M26-3: 差し戻しfixの3段階段。round 1-2=worker → 3=midEscalation(未設定なら
      // escalationへフォールバック済み)→ 4以降=escalation(既定planner)
      const provider =
        round >= 4
          ? args.escalationProvider
          : round === 3
            ? args.midEscalationProvider
            : args.workerProvider;
      await deps.runFix(provider, buildFixTask(target, card, cfg.passMode ?? 'severity'), args.signal);
    },
    onCard: emitCard,
    signal: args.signal,
  });

  if (args.signal.aborted) return null;

  if (result.reviewFailed && result.final === null) {
    args.emit({
      kind: 'info',
      sessionId: args.sessionId,
      message: '品質レビューを実行できなかった(採点出力が得られず)。今回は素通しで続行します',
    });
    return 'レビュー実行失敗(素通し)';
  }

  const final = result.final!;
  if (result.resolved) {
    return result.fixRounds > 0
      ? `合格 平均${final.average}/5(差し戻し${result.fixRounds}回で改善)`
      : `合格 平均${final.average}/5`;
  }

  // 上限到達でも閾値未満: 残課題を提示。自律モードOFFなら承認を仰ぐ
  emitCard({ ...final, unresolved: true });
  const remaining = final.findings
    .map((f, i) => `${i + 1}. ${f.file}(${f.location}): ${f.problem} → ${f.fix}`)
    .join('\n');
  if (args.autonomous) {
    args.emit({
      kind: 'info',
      sessionId: args.sessionId,
      message: `⚠ 品質レビュー: 差し戻し上限(${cfg.maxRoundsPerMilestone}回)でも閾値未満(平均${final.average}/5)。残課題${final.findings.length}件を許容して続行します(自律モード)`,
    });
  } else {
    const decision = await deps.requestApproval(
      remaining.slice(0, 1500) || final.summary.slice(0, 1500),
      `品質レビュー: 差し戻し上限(${cfg.maxRoundsPerMilestone}回)に達しても閾値未満(平均${final.average}/5)。残課題を許容して先へ進みますか?(拒否した場合は追加の修正指示をチャットで送ってください)`,
      args.signal,
    );
    args.emit({
      kind: 'info',
      sessionId: args.sessionId,
      message:
        decision === 'deny'
          ? '品質レビューの残課題が許容されなかった。追加の修正指示をチャットで送ってください'
          : '品質レビューの残課題を許容して続行します',
    });
  }
  return `上限到達・残課題${final.findings.length}件(平均${final.average}/5)`;
}
