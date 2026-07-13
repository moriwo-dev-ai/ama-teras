import { randomUUID } from 'node:crypto';
import type {
  ApprovalBatch,
  ApprovalBatchItem,
  EvolutionJobSummary,
  GodClockJob,
  InboxItem,
  MetricsSnapshot,
  OperationsDraft,
  ParamChange,
  ProjectProfile,
} from '../../shared/types';
import { extractJson } from './llm';

/**
 * M33-4: 神議(かむはかり)— 中層の戦略ループ。
 * 受け箱+メトリクス履歴を読み、planner帯で「何が効いたか・次の一手」を考え、
 * ①承認バッチ(ユーザーへの1枚カード) ②神々のパラメータ調整 ③能力ギャップ を出す。
 *
 * 【2段階制(鉄則・テストで固定)】
 * - 自律で変更可(記録+運営スレッド通知のみで即適用):
 *   実行間隔(上下限クランプ必須)/検索キーワード・判定条件の調整/神の一時停止・再開/
 *   許可済みツールの有効・無効切替/ツール使用レート間隔/予算の引き下げ
 * - 人間承認必須:
 *   新ツールの付与/判定プロンプトの書き換え/予算の引き上げ/神の新設・削除
 * 神議自身は外部発信を実行しない(承認された実行系も岩戸ゲート経由)。
 */

export type { ApprovalBatch, ApprovalBatchItem, ParamChange };

/** 2段階制の判定(純関数)。予算は増減で分岐する */
export function classifyParamChange(change: ParamChange): 'autonomous' | 'approval' {
  const autonomous: string[] = ['interval', 'keywords', 'pause', 'resume', 'tool-toggle', 'rate-limit', 'budget-decrease'];
  return autonomous.includes(change.kind) ? 'autonomous' : 'approval';
}

/**
 * 予算変更の向き判定(純関数)。LLMが 'budget-decrease' を騙って増額してくる事故を防ぐため、
 * 現在値との比較で必ず再分類する(宣言ではなく実際の値で判定)。
 */
export function reclassifyBudgetChange(change: ParamChange, currentBudget: number): ParamChange {
  if (change.kind !== 'budget-decrease' && change.kind !== 'budget-increase') return change;
  const value = typeof change.value === 'number' ? change.value : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return { ...change, kind: 'budget-increase' }; // 不正値は安全側=承認必須
  return { ...change, kind: value < currentBudget ? 'budget-decrease' : 'budget-increase' };
}

export interface KamuhakariRunResult {
  analysis: string;
  appliedChanges: { change: ParamChange; detail: string }[];
  batch: ApprovalBatch | null;
  tokensUsed: number;
}

/** 神議プロンプト(planner帯) */
export function buildKamuhakariPrompt(input: {
  unread: InboxItem[];
  history: MetricsSnapshot[];
  postedDrafts: OperationsDraft[];
  /**
   * M57: 出す準備はできたが**まだ公開されていない**もの(Zennの published:false /
   * GitHubのdraft release)。posted と混ぜると「発信したのに反応が無い」と誤診する
   */
  stagedDrafts?: OperationsDraft[];
  jobs: GodClockJob[];
  currentKeywords: string[];
  /** M41-3: 運営対象プロジェクト */
  project: ProjectProfile;
  /**
   * M52: 進化ジョブの実状態。**これを渡していなかったため、神議は進化の結果を一切知らず**、
   * 失敗したジョブを「承認待ち」と呼び、存在しない滞留のレビューを人間に催促していた(実害)。
   */
  evolutionJobs?: EvolutionJobSummary[];
}): string {
  const inboxSummary = input.unread
    .slice(0, 40)
    .map((i) => `- [${i.kind}] ${i.godId}: ${i.title}`)
    .join('\n');
  const series = input.history
    .slice(-14)
    .map((s) => {
      const gh = Object.entries(s.github)
        .map(([r, m]) => `${r}:★${m.stars}/閲覧${m.views ?? '?'}/DL${m.downloads ?? '?'}`)
        .join(' ');
      const zn = Object.entries(s.zenn)
        .map(([slug, m]) => `zenn:${slug}♥${m.liked}`)
        .join(' ');
      return `- ${s.ts.slice(5, 16)} ${gh} ${zn}`;
    })
    .join('\n');
  const posted = input.postedDrafts.map((d) => `- ${d.postedAt ?? ''} [${d.media ?? '?'}] ${d.title}`).join('\n');
  const staged = (input.stagedDrafts ?? [])
    .map((d) => `- ${d.postedAt ?? ''} [${d.media ?? '?'}] ${d.title}`)
    .join('\n');
  const clocks = input.jobs
    .map((j) => `- ${j.godId}: ${j.enabled ? '稼働' : '停止'} 間隔${j.intervalMin}分 予算${j.dailyTokenBudget}(今日${j.spentToday})`)
    .join('\n');
  const evolution = (input.evolutionJobs ?? [])
    .slice(-12)
    .map((j) => {
      // 失敗の理由は神議が学ぶための一次情報。要約せず、先頭だけ切って渡す
      const why =
        j.status === 'failed' && j.error !== undefined && j.error !== ''
          ? ` — 失敗理由: ${j.error.replace(/\s+/g, ' ').slice(0, 160)}`
          : '';
      const failedGate = j.gates.find((g) => !g.ok);
      const gate = failedGate === undefined ? '' : ` (落ちたゲート: ${failedGate.name})`;
      return `- #${j.id} [${j.status}] ${j.description}${gate}${why}`;
    })
    .join('\n');

  return `あなたは「神議(かむはかり)」— OSSプロジェクト ${input.project.name} の運営戦略会議。

# プロジェクト
${input.project.name}: ${input.project.description}
目的: どうすれば本当にAIを楽しむ人々にこのプロジェクトが届くか。誇張やスパムは絶対にしない。

# 受け箱(未読)
${inboxSummary || '(なし)'}

# メトリクス時系列(直近)
${series || '(なし)'}

# 投下履歴(**実際に公開された**発信。これだけが人の目に触れている)
${posted || '(なし)'}

# 公開待ち(準備はできたが**まだ誰も読めない**)
${staged || '(なし)'}
※ Zenn記事は published: false でコミットされ、GitHub Release は draft で作られる。
   どちらも**外からは読めない**。ここに並ぶものは「反応が無かった発信」ではなく、
   **露出ゼロ**。人間がZenn管理画面/GitHubで公開ボタンを押すまで何も起きない。
   反応の少なさをこれらのせいにしないこと。むしろ、公開されていない事実自体を指摘すること。

# 神々の時計と予算
${clocks}

# 進化ジョブの実状態(これが唯一の事実。ここに無いジョブは存在しない)
${evolution || '(なし)'}
※ status が failed のジョブは**終わっている**。承認待ちではない。
   「承認待ちが滞留している」等、ここから読み取れない状態を推測で書かないこと。
   人間に承認・レビューを催促するだけの提案(実体のある行動を伴わないもの)は出さないこと。

# 現在の巡回キーワード
${input.currentKeywords.join(', ') || '(未設定)'}

# あなたの権限(2段階制)
自律で変更可: 実行間隔(15分〜24時間)・検索キーワード・神の一時停止/再開・予算の引き下げ
人間承認必須: 新ツールの付与・判定プロンプト書き換え・予算の引き上げ・神の新設/削除
外部発信(投稿・コメント等)は自分では実行できない。提案として承認バッチに載せるだけで、
承認された実行も必ず岩戸ゲート(人間の最終確認ダイアログ)を通る。

# 能力ギャップの3分岐(足りない能力を見つけたら branch を選ぶ)
- adhoc: 単発ならエージェント本体がその場でカバー(ユーザーが通常チャットで実行する下書きを detail に)
- evolve: 神への能力追加 = request_capability の起票案(detail に依頼文)
- new-god: 新しい神の作成 = godDraft に定義JSON({id,name,engine,clock,dailyTokenBudget,enabled}。
  engine は metrics-observer/community-patrol/draft-writer/issue-gatekeeper のみ)
  **命名の掟(ブランド)**: 神の名は必ず日本神話(八百万の神)から採る。役割に対応する神を選ぶこと。
  既存: OMOI-kami(思兼神=知恵・観測)/ AMENO-uzume(天鈿女命=芸能・広報)/
  TEDIKA-rao(手力男命=岩戸を開いた力・門番)/ AMENO-koyane(天児屋命=祝詞・司会進行)。
  候補例: SARUTA-hiko(猿田彦=道案内・オンボーディング)/ SUKUNA-bikona(少名毘古那=医薬・修復)/
  ISHIKORI-dome(石凝姥命=鏡作り・ビルド/リリース)/ KOTOSHIRO-nushi(事代主=託宣・予測)。
  id は英小文字ハイフン(例: saruta-hiko)、name は「SARUTA-hiko(猿田彦・道案内)」の形

# 出力(JSONのみ)
{
 "analysis": "何が効いたか・現状分析(3〜6文。データが乏しければ正直にそう書く)",
 "paramChanges": [{"kind":"interval|keywords|pause|resume|budget-decrease|budget-increase|judge-prompt|god-create","godId":"...","reason":"...","value": 数値または["キーワード"]}],
 "proposals": [{"kind":"exec-action|capability-gap","title":"...","detail":"...","branch":"adhoc|evolve|new-god(capability-gapのみ)","godDraft":{...}(new-godのみ)}]
}
変更が不要なら paramChanges は空配列でよい。提案は多くても5件。`;
}

export interface KamuhakariProposal {
  kind: 'exec-action' | 'capability-gap';
  title: string;
  detail: string;
  gap?: { branch: 'adhoc' | 'evolve' | 'new-god'; godDraft?: unknown };
}

export function parseKamuhakariOutput(raw: string): {
  analysis: string;
  paramChanges: ParamChange[];
  proposals: KamuhakariProposal[];
} | null {
  const parsed = extractJson(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const analysis = String(rec['analysis'] ?? '').trim();
  const paramChanges: ParamChange[] = [];
  if (Array.isArray(rec['paramChanges'])) {
    for (const c of rec['paramChanges'] as unknown[]) {
      const cr = c as Record<string, unknown>;
      const kind = String(cr['kind'] ?? '');
      const godId = String(cr['godId'] ?? '');
      if (kind === '' || godId === '') continue;
      const change: ParamChange = { kind: kind as ParamChange['kind'], godId, reason: String(cr['reason'] ?? '') };
      if (cr['value'] !== undefined) change.value = cr['value'];
      paramChanges.push(change);
    }
  }
  const proposals: KamuhakariProposal[] = [];
  if (Array.isArray(rec['proposals'])) {
    for (const p of rec['proposals'] as unknown[]) {
      const pr = p as Record<string, unknown>;
      const kind = pr['kind'] === 'exec-action' ? ('exec-action' as const) : ('capability-gap' as const);
      const title = String(pr['title'] ?? '').trim();
      if (title === '') continue;
      const proposal: KamuhakariProposal = { kind, title, detail: String(pr['detail'] ?? '') };
      if (kind === 'capability-gap') {
        // M33-6: 3分岐。不明値は adhoc(最も安全=人間が通常チャットで対応)へ
        const branch = pr['branch'];
        proposal.gap = {
          branch: branch === 'evolve' || branch === 'new-god' ? branch : 'adhoc',
          ...(pr['godDraft'] !== undefined ? { godDraft: pr['godDraft'] } : {}),
        };
      }
      proposals.push(proposal);
    }
  }
  if (analysis === '' && paramChanges.length === 0 && proposals.length === 0) return null;
  return { analysis, paramChanges, proposals };
}

/** 承認バッチの組み立て(純関数) */
export function buildApprovalBatch(
  analysis: string,
  approvalChanges: ParamChange[],
  proposals: KamuhakariProposal[],
): ApprovalBatch | null {
  const items: ApprovalBatchItem[] = [
    ...approvalChanges.map((change) => ({
      id: randomUUID(),
      kind: 'param-approval' as const,
      title: `[${change.godId}] ${change.kind}: ${change.reason}`,
      detail: `値: ${JSON.stringify(change.value)}`,
      change,
      status: 'pending' as const,
    })),
    ...proposals.map((p) => ({
      id: randomUUID(),
      kind: p.kind === 'exec-action' ? ('exec-action' as const) : ('capability-gap' as const),
      title: p.title,
      detail: p.detail,
      ...(p.gap !== undefined ? { gap: p.gap } : {}),
      status: 'pending' as const,
    })),
  ];
  if (items.length === 0) return null;
  return { id: randomUUID(), ts: new Date().toISOString(), analysis, items };
}
