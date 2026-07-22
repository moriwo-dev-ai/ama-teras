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

/** M64: gh / zenn-content から引いた「実際に公開されているか」の一次情報 */
export interface PublishState {
  releases: { repo: string; tag: string; draft: boolean }[];
  /**
   * published = zenn-content の frontmatter が published: true か(=こちらが出したつもり)。
   * live = **Zennの公開APIで実際に読めるか**(=世界がそう認めているか)。
   * M76: published:true にして push したのに Zenn 側が同期せず、**誰も読めないまま
   * 「投稿済み」と記録された**記事が実際に出た。出したつもりと、出ていることは別
   */
  zennArticles: { slug: string; published: boolean; live?: boolean; title?: string }[];
  /** 一次情報を引けなかった理由(gh不在・パス未設定など)。引けていないことを隠さない */
  unavailable: string[];
}

export function formatPublishState(state: PublishState | undefined): string {
  if (state === undefined) return '(取得していない — 公開状態について断定しないこと)';
  const lines: string[] = [];
  for (const r of state.releases) {
    lines.push(`- GitHub ${r.repo} ${r.tag}: ${r.draft ? '**draft(誰も落とせない)**' : '公開済み(世に出ている)'}`);
  }
  for (const a of state.zennArticles) {
    // 「published: true にした」と「Zennで実際に読める」は別。後者だけが露出
    const status = !a.published
      ? '**published: false(誰も読めない)**'
      : a.live === false
        ? // M79: ここで止まっているものに「公開してください」と言っても無意味(すでに公開操作は済んでいる)。
          // 詰まりを解くのは再デプロイ(人間が押す)であって、公開ボタンではない
          '**published: true にしたが、Zennではまだ読めない(同期未完/失敗)。露出ゼロ。公開操作は済んでいるので「公開する」提案は無意味 — 必要なのは再デプロイ(人間の操作)**'
        : a.live === true
          ? '公開済み(Zennで実際に読める)'
          : '公開済み(published: true。Zenn側は未確認)';
    lines.push(`- Zenn ${a.slug}: ${status}`);
  }
  for (const u of state.unavailable) lines.push(`- (不明) ${u}`);
  return lines.length === 0 ? '(該当なし)' : lines.join('\n');
}

/** 神議プロンプト(planner帯) */
/**
 * M99-11: メトリクス時系列の整形(神議・運営チャット共用)。
 * clone は観測(OMOI-kami)が取っていたのにここで落としていたため、神議は
 * 「クローン数の時系列データは未取得」と答えた(勘違いではなく、本当に渡されていなかった)。
 * 渡すデータを増やしたら、この関数に足すこと(戦略会議とチャットの知識が同時に揃う)
 */
export function formatMetricsSeries(history: MetricsSnapshot[]): string {
  return history
    .slice(-14)
    .map((s) => {
      const gh = Object.entries(s.github)
        .map(
          ([r, m]) =>
            `${r}:★${m.stars}/閲覧${m.views ?? '?'}/DL${m.downloads ?? '?'}/clone${m.clones ?? '?'}(u${m.clonesUnique ?? '?'})`,
        )
        .join(' ');
      const zn = Object.entries(s.zenn)
        .map(([slug, m]) => `zenn:${slug}♥${m.liked}`)
        .join(' ');
      return `- ${s.ts.slice(5, 16)} ${gh} ${zn}`;
    })
    .join('\n');
}

/**
 * M99-11: 運営チャット(スレッド即応)の文脈。以前は「神々の時計+直近会話」しか渡しておらず、
 * チャットは運営をほぼ何も知らない状態で答えていた(クローン推移を「未取得」と誤答した実害)。
 * 戦略会議(buildKamuhakariPrompt)と同じ一次情報を、チャット向けに圧縮して渡す
 */
export function buildThreadContext(input: {
  history: MetricsSnapshot[];
  jobs: GodClockJob[];
  postedDrafts: OperationsDraft[];
  stagedDrafts: OperationsDraft[];
  activeDraftTitles: string[];
  evolutionJobs: EvolutionJobSummary[];
  publishState?: PublishState;
}): string {
  const clocks = input.jobs
    .map((j) => `- ${j.godId}: ${j.enabled ? '稼働' : '停止'} 間隔${j.intervalMin}分 予算${j.dailyTokenBudget}(今日${j.spentToday})`)
    .join('\n');
  const evolution = input.evolutionJobs
    .slice(-8)
    .map((j) => `- #${j.id} [${j.status}] ${j.description.slice(0, 60)}`)
    .join('\n');
  return `# メトリクス時系列(直近。clone=クローン数, u=ユニーク)
${formatMetricsSeries(input.history) || '(なし)'}

# 神々の時計
${clocks || '(なし)'}

# 発信の状態
現役の下書き: ${input.activeDraftTitles.length}件${input.activeDraftTitles.length > 0 ? `(${input.activeDraftTitles.slice(0, 6).join(' / ')})` : ''}
投稿済み(直近): ${input.postedDrafts.slice(-5).map((d) => `[${d.media ?? '?'}] ${d.title}`).join(' / ') || '(なし)'}
公開待ち(まだ誰も読めない): ${input.stagedDrafts.map((d) => d.title).join(' / ') || '(なし)'}

# 公開状態の一次情報(推測禁止。ここに無いことは「分からない」と答える)
${formatPublishState(input.publishState)}

# 進化ジョブ(直近)
${evolution || '(なし)'}`;
}

/** M99-11: チャット返信に添えられる機械可読アクション。今は run-god のみ */
export interface ThreadAction {
  kind: 'run-god';
  godId: string;
}

/**
 * 返信本文から <action>{...}</action> を1つだけ取り出す(表示用本文からは取り除く)。
 * 不正なJSON・未知のkindは無視して本文だけ返す(チャットを壊さない)
 */
export function parseThreadAction(reply: string): { body: string; action: ThreadAction | null } {
  const m = /<action>([\s\S]*?)<\/action>/.exec(reply);
  if (m === null) return { body: reply.trim(), action: null };
  const body = (reply.slice(0, m.index) + reply.slice(m.index + m[0].length)).trim();
  try {
    const parsed: unknown = JSON.parse(m[1] ?? '');
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)['kind'] === 'run-god' &&
      typeof (parsed as Record<string, unknown>)['godId'] === 'string'
    ) {
      return { body, action: { kind: 'run-god', godId: (parsed as Record<string, unknown>)['godId'] as string } };
    }
  } catch {
    /* 不正なアクションは無視(本文は生かす) */
  }
  return { body, action: null };
}

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
  /**
   * M64: 公開状態の一次情報。プロンプトに「GitHub Release は draft で作られる」という
   * 一般論しか無かったため、神議は実際には公開済み(draft=false)のリリースを
   * 「draftのまま止まっている」と断定した。推測させないために、gh と zenn-content から
   * 引いた実状態をそのまま渡す
   */
  publishState?: PublishState;
}): string {
  const inboxSummary = input.unread
    .slice(0, 40)
    .map((i) => `- [${i.kind}] ${i.godId}: ${i.title}`)
    .join('\n');
  const series = formatMetricsSeries(input.history);
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
※ ここに並ぶものは「反応が無かった発信」ではなく**露出ゼロ**。人間が公開ボタンを
   押すまで何も起きない。反応の少なさをこれらのせいにせず、未公開の事実自体を指摘すること。

# 公開状態の一次情報(gh / zenn-content から今引いた実測。**推測禁止**)
${formatPublishState(input.publishState)}
※ 何が公開済みで何が未公開かは、この一覧だけが根拠。ここに載っていないものについて
   「まだdraftのはず」「公開されていないはず」と断定してはいけない(実際に、公開済みの
   リリースを「draftのまま止まっている」と誤って断定した回がある)。

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

# 言行一致(M63: これを守れずに3回連続で「分析だけ」を出した)
分析で問題を指摘したなら、**あなたの権限内でできることは必ず実行(paramChanges)し、
権限外のものは提案(proposals)にする**。
例:「下書きを量産しても在庫が積み上がるだけ」と書いたなら、その神を pause しろ(自律で可能)。
「巡回が機能していない」と書いたなら、原因が人間側にあることを proposals で1件挙げろ。
言うだけで何もしないなら、あなたは神議ではなく傍観者だ。
逆に、指摘すべき問題が無く、変更する必要も無いなら、両方を空にしてよい(無理に作らない)。

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
