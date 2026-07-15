import type { LLMProvider } from '../providers/types';
import { runAgentLoop } from '../agent/loop';
import { executeToolWithApproval } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import type { ToolPlugin } from '../tools/types';
import { ApprovalBroker } from '../agent/approval';
import { assertSafeToolName } from '../tools/name';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface EvolutionRequest {
  description: string;
  expectedIO: string;
  /** M20: 進化スコープ。未指定は 'tool'(従来)。renderer/core は常に人間承認+再起動 */
  scope?: import('../../shared/types').EvolutionScope;
  /** M23-7: 依頼元の会話ID(結果をモデルへ自動フィードバックする宛先。手動起動では無し) */
  originConversationId?: string;
  /**
   * M25-8: 修正対象の既存ツール名(scope='tool'のみ)。指定すると「新規作成」ではなく
   * 「既存プラグインファイルの修正」として扱われる(プロンプトが変わり、生成結果の
   * toolName がこの名前と一致することを manager.ts が検証する)
   */
  targetTool?: string;
  /**
   * M27-4: プラグインインポート元のディレクトリ(検査済み)。指定するとLLM生成の
   * 代わりに ImportJobRunner がファイルコピーを行う(検証ゲート以降は完全に同一経路)
   */
  importFrom?: string;
}

export interface JobArtifacts {
  /** 生成された新ツール名(scope='tool' のスモークテスト対象。renderer/core では無し) */
  toolName?: string;
  /** スモークテスト用サンプル入力(scope='tool') */
  smokeInput?: unknown;
  /** M20: renderer/core の変更概要(昇格ダイアログの補足) */
  summary?: string;
}

/** 進化ジョブの生成器。テスト・M4検証では固定生成物を書くモックに差し替える */
export interface EvolutionJobRunner {
  generate(
    req: EvolutionRequest,
    worktreeDir: string,
    log: (line: string) => void,
    signal: AbortSignal,
    /** 前回の検証ゲート失敗内容。再生成(2回目)のときのみ渡される */
    feedback?: string,
  ): Promise<JobArtifacts>;
}

import { SCOPE_ALLOWLISTS } from './scopes';

/** 書き込み許可(scope='tool'): プラグインと同ディレクトリのテストのみ(ARCHITECTURE §6.2) */
export const EVOLUTION_WRITE_ALLOWLIST = SCOPE_ALLOWLISTS.tool;

/** M20: renderer/core 用のシステムプロンプト(既存コードの最小差分修正) */
const CORE_JOB_SYSTEM_PROMPT = (scope: 'renderer' | 'core', allowlist: string[]): string =>
  `あなたはAMA-terasの進化ジョブ(scope: ${scope})。本体コードの改善を1件、最小差分で実装する。

厳守事項:
- 書き込みは ${allowlist.join(' / ')} 配下のみ許可(機械的にも強制される)
- 保護領域(聖域)は変更禁止で、差分に1行でも触れたらジョブ全体が無条件拒否される:
  src/main/evolution / 承認関連(approval.ts・Approvalコンポーネント・ipc.ts・preload・shared/ipc.ts)/
  secrets.ts / userDataMigration.ts / CLAUDE.md / docs/PROTECTED.md
- 既存のコードスタイル・規約に合わせ、変更は依頼の範囲だけに絞る。新規依存の追加は禁止
- シンボリックリンクの作成は禁止(検出したら拒否される)

コーディング規約(違反するとtypecheckゲートで失格):
- TypeScript strict + noUncheckedIndexedAccess。any 禁止(入力は unknown+型ガード)

完了前の自己検証(必須):
- bash で \`npm run typecheck\` → エラーゼロ
- bash で \`npx vitest run\` → 全合格(既存テストを壊さない)
- bash で \`npm run build\` → 成功
- 【重要】bash は制限モードで検証コマンド(npm run <script> / npx vitest run / npx tsc)のみ。
  ファイルの作成・変更は必ず write_file / edit_file を使う

最後の応答で、変更概要を \`\`\`json {"summary": "..."} \`\`\` のコードブロックで必ず出力する`;

const JOB_SYSTEM_PROMPT = `あなたはAMA-terasの進化ジョブ。新しいツールプラグインを1つ実装する
(依頼が「既存ツールの修正」の場合は、新規作成ではなく該当ファイルを直接編集して直す。
下のタスク文で対象ツール名が明示されていたら必ずそのファイルを読んでから編集すること)。

厳守事項:
- 書き込みは src/main/tools/plugins/ 配下のみ許可されている(機械的にも強制される)
- 新規作成の成果物: (1) src/main/tools/plugins/<name>.ts のプラグイン本体
  (2) src/main/tools/plugins/<name>.test.ts のvitestユニットテスト。
  既存ツールの修正では、この2ファイルを直接編集する(新しい名前のファイルを作ってはならない)
- プラグイン規約: export default { name, description, inputSchema, risk, tags?, warnings?, execute }
  satisfies ToolPlugin。name はファイル名と一致(修正時は絶対に変更しない)。
  tags は分類(例: ['ファイル操作']・['Web操作']・['コマンド実行']・['テキスト処理'])を1つ以上つける。
  型は import type { ToolPlugin, ToolContext, ToolResult } from '../types' で参照。
  実行時importはnode組み込みモジュールのみ可(相対importの実行時参照は禁止)
- child_process やネットワークアクセスを使う場合は warnings に自己申告すること

コーディング規約(違反するとtypecheckゲートで失格になる):
- TypeScript strict + noUncheckedIndexedAccess。配列・オブジェクトのインデックスアクセスは
  undefined になり得るため、必ずガード(if文・?? デフォルト値・非nullを保証してからの ! )を入れる
- any 禁止。入力は unknown で受けて型ガードで絞る

完了前の自己検証(必須):
- bash ツールで \`npm run typecheck\` を実行し、エラーゼロを確認する
- bash ツールで \`npx vitest run src/main/tools/plugins/<name>.test.ts\` を実行し、全テスト合格を確認する
- パッケージマネージャは npm / npx のみ(pnpm・yarnは無い)。依存の追加は禁止
- どちらかが失敗したら修正して再実行し、合格するまで完了しない
- 【重要】bash は制限モードで、実行できるのは検証コマンド(npm run <script> / npx vitest run <path> /
  npx tsc)のみ。ファイルの作成・変更は必ず write_file / edit_file を使う(bash でのリダイレクトや
  cp・echo による書き込みは拒否される)。シェル連結(&&・;・|)やリダイレクト(>)も使えない

最後の応答で、生成したツール名と、スモークテスト用のサンプル入力JSONを
\`\`\`json {"toolName": "...", "smokeInput": {...}} \`\`\` のコードブロックで必ず出力する`;

/**
 * M91: 配布版のツール生成プロンプト。開発版との違いは**自己検証をやらせないこと**。
 * 配布版には npm も vitest もリポジトリも無い(bashで typecheck を叩けば必ず失敗する)。
 * 検証はアプリ側のプラグイン単位ゲート(tools/verify.ts)が本物として回し、
 * 落ちたら失敗内容を渡して作り直させる(ここは同じ2回ループ)
 */
const LOCAL_TOOL_JOB_SYSTEM_PROMPT = `あなたはAMA-terasの進化ジョブ。新しいツールプラグインを1つ実装する
(依頼が「既存ツールの修正」なら、渡された既存ファイルを直接編集して直す)。

成果物(この2つだけ。他のファイルは書かない):
- src/main/tools/plugins/<name>.ts        … プラグイン本体
- src/main/tools/plugins/<name>.test.ts   … vitest 形式のユニットテスト(必須。最低2ケース)

プラグイン規約(ここを外すと型検査ゲートで必ず落ちる。実測で多い間違いを挙げる):
- export default { name, description, inputSchema, risk, tags?, warnings?, execute } satisfies ToolPlugin
- name はファイル名と一致(修正時は絶対に変えない)
- execute は **async** で、**2引数**を宣言する:
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> { … }
  ・async を付けない(ToolResult を直接返す)と「Promise<ToolResult> ではない」で落ちる
  ・ctx を省く(1引数で書く)と、テストから execute(input, ctx) で呼べずに落ちる(satisfies は引数の数を保つ)
- ToolResult は **{ content: string; isError?: boolean }** だけ。ok / data / result のようなフィールドは無い。
  テストで r.ok を見ると落ちる。成功も失敗も content(文字列)で返し、失敗時だけ isError: true
- 型は import type { ToolPlugin, ToolContext, ToolResult } from '../types'(型専用import)
- 実行時 import は node 組み込みモジュールのみ。npm パッケージ・相対importの実行時参照は禁止
- テストからロジックを呼べるよう、純粋な関数を named export し、テストはそれを import する
  (テストの import 元は './<name>' とすること)
- child_process / ネットワークを使う場合は warnings に自己申告する

コーディング規約(違反すると型検査ゲートで失格):
- TypeScript strict + noUncheckedIndexedAccess。配列・オブジェクトのインデックスアクセスは
  undefined になり得るので必ずガードする。any 禁止(入力は unknown で受けて型ガード)

重要 — 検証はアプリが行う:
- bash による検証(npm run typecheck / npx vitest 等)は**実行しない**。この環境にnpmは無い。
  書き終えたら完了すること。アプリが型検査・テスト実行・スモークを本物で回し、
  不合格なら失敗内容を渡して作り直しを依頼する
- ファイルの作成・変更は write_file / edit_file を使う

テストで使えるマッチャ(検証はアプリ内蔵の実行機で、**本物のvitestではない**。下のマッチャだけが動く。
これ以外を使うと「is not a function」で落ち、作り直しても同じ所で落ち続ける):
- expect(x). の後: toBe / toEqual / toStrictEqual / toMatchObject / toContain / toContainEqual / toMatch /
  toHaveLength / toHaveProperty / toBeTruthy / toBeFalsy / toBeNull / toBeUndefined / toBeDefined /
  toBeNaN / toBeInstanceOf / toBeCloseTo / toBeGreaterThan(OrEqual) / toBeLessThan(OrEqual) / toThrow
- 否定は .not.<matcher>。例外は expect(() => f()).toThrow(...)。
  非同期は await expect(p).rejects.toThrow(...) / await expect(p).resolves.toBe(...)
- vi.mock・スナップショット・タイマー操作は無い。ロジックを純関数として named export し、
  その入出力を上のマッチャで確かめること(execute は import して {content} を検証してよい)

最後の応答で、ツール名とスモークテスト用のサンプル入力JSONを
\`\`\`json {"toolName": "...", "smokeInput": {...}} \`\`\` のコードブロックで必ず出力する`;

/**
 * M92-B1: 生成エージェントに見せてよい道具の allowlist(コードを書くのに要る最小限だけ)。
 *
 * 【なぜ denylist ではなく allowlist か】以前は「危ない名前を引く」denylist だったが、それは
 * **今知っている悪者しか止められない**。将来、実行系の新ツール(例: run_shell)が生成・導入されると、
 * 名前が違うので素通りし、また「実行できる道具がある→環境を調べよう→無限ループ」(M91-5)を再発する。
 * allowlist なら **知らない新顔を既定で入れない** ので、将来分まで構造的に安全。
 * 広げるときは人間が明示的に足す(思想の一貫性: 手足を増やすのは承認事項)。
 */
export const GENERATION_TOOL_ALLOWLIST = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'grep',
]);

/**
 * M91: allowlist を将来広げても**必ず**外す道具(多層防御の内側)。
 * - bash 系: 検証はアプリが回す(この環境に npm は無い)。持たせると無限に環境調査を始める
 * - 進化・要望系: ジョブの中から別のジョブを起こさせない(入れ子の自己進化は誰も追えない)
 */
export const EXCLUDED_FROM_TOOL_GEN = new Set([
  'bash',
  'bash_output',
  'kill_bash',
  'request_capability',
  'request_core_change',
  'evolution_jobs',
]);

/**
 * M92-B1/B2: 生成文脈に見せてよいか。
 * allowlist に居る(B1)∧ 明示除外に無い ∧ **exec 相当でない(B2 能力フィルタ)**。
 * B2 は「名前が allowlist でも、任意コード実行相当(risk:'exec')なら入れない」= 既知の原因
 * (=コマンドを実行できる道具)をクラスで塞ぐ。allowlist をすり抜ける将来の上書きにも効く。
 */
export function isAllowedForGeneration(t: { name: string; risk?: ToolPlugin['risk'] }): boolean {
  if (!GENERATION_TOOL_ALLOWLIST.has(t.name)) return false;
  if (EXCLUDED_FROM_TOOL_GEN.has(t.name)) return false;
  if (t.risk === 'exec') return false;
  return true;
}

/** 生成エージェントに見せる道具(allowlist+能力フィルタを通したもの)。ToolRegistry を構造的に満たす */
export function toolsForGeneration(full: { list(): ToolPlugin[]; get(name: string): ToolPlugin | undefined }): {
  list(): ToolPlugin[];
  get(name: string): ToolPlugin | undefined;
} {
  return {
    list: () => full.list().filter(isAllowedForGeneration),
    get: (name: string) => {
      const t = full.get(name);
      return t !== undefined && isAllowedForGeneration(t) ? t : undefined;
    },
  };
}

/**
 * M92-A1: 手本(few-shot)の仕組み。Claude Code が速い一番の理由は「似た既存を読んで形を写す」こと。
 * 生成エージェントは既存を読めるが手渡しされていないので、依頼に最も近い既存プラグインを選び、
 * 本体+テストの全文を **真似る対象** としてプロンプトへ差し込む。
 */
export interface ExemplarCandidate {
  name: string;
  description: string;
  tags?: string[];
}

/** 手本が全く選べないときのフォールバック(綺麗で分かりやすい定番プラグイン。上から在るものを使う) */
export const DEFAULT_EXEMPLARS = ['csv_to_markdown', 'yaml_to_json', 'text_stats', 'wc_file'];

/**
 * トークン化。日英混在(「jsonをyamlへ変換」等)を扱うため:
 * - ASCII 英数字は語ごと(json/yaml/svg/png など。最も効く手がかり)
 * - 日本語(かな/カナ/漢字)の連なりは分かち書きが無いので 2-gram にする(変換/画像/表 を拾う)
 * この分離をしないと、ASCII が隣の日本語に貼り付いて巨大トークンになり一致しない。
 */
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) tokens.add(m[0]);
  for (const run of lower.match(/[ぁ-んァ-ヶー一-龠]+/g) ?? []) {
    if (run.length < 2) tokens.add(run);
    else for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 依頼に最も近い既存プラグイン名を選ぶ(キーワード重なりで採点)。
 * 重なりがゼロなら DEFAULT_EXEMPLARS の在るものへフォールバック、それも無ければ null。
 * exclude(修正対象そのもの)は手本にしない。
 */
export function chooseExemplarName(
  req: { description: string; expectedIO: string },
  candidates: ExemplarCandidate[],
  exclude?: string,
): string | null {
  const wanted = tokenize(`${req.description} ${req.expectedIO}`);
  const pool = candidates.filter((c) => c.name !== exclude);
  let best: { name: string; score: number } | null = null;
  for (const c of pool) {
    const have = tokenize(`${c.name} ${c.description} ${(c.tags ?? []).join(' ')}`);
    let score = 0;
    for (const w of wanted) if (have.has(w)) score++;
    if (best === null || score > best.score) best = { name: c.name, score };
  }
  if (best !== null && best.score > 0) return best.name;
  // 重なりが無い: 定番の手本(在るものの中から)
  const names = new Set(pool.map((c) => c.name));
  return DEFAULT_EXEMPLARS.find((n) => names.has(n)) ?? null;
}

function readPluginFile(dirs: string[], file: string): string | null {
  for (const d of dirs) {
    const p = join(d, file);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 手本セクションの本文。既存プラグインの本体+テストの全文を「形を真似る対象」として整形する。
 * ソースが読めなければ空文字(手本無しでも生成は続ける)。
 */
export function buildExemplarSection(pluginDirs: string[], name: string | null): string {
  if (name === null) return '';
  const src = readPluginFile(pluginDirs, `${name}.ts`);
  if (src === null) return '';
  const test = readPluginFile(pluginDirs, `${name}.test.ts`);
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n… (以降省略)` : s);
  const parts = [
    '',
    `── 参考: 既存プラグイン「${name}」の実例。**この形・書き方・satisfies・テストの流儀を真似よ**` +
      '(機能そのものは依頼に合わせて変える。丸写しはしない)──',
    `===== ${name}.ts =====`,
    clip(src, 6000),
  ];
  if (test !== null) parts.push(`===== ${name}.test.ts =====`, clip(test, 4000));
  parts.push('── 参考ここまで ──', '');
  return parts.join('\n');
}

/** ToolRegistry の list() から手本候補を起こす */
function exemplarCandidates(plugins: ToolPlugin[]): ExemplarCandidate[] {
  return plugins.map((p) => ({ name: p.name, description: p.description, ...(p.tags ? { tags: p.tags } : {}) }));
}

/**
 * M91: 配布版(git・ソースツリー無し)のツール生成ランナー。
 * cwd は userData 配下のサンドボックス。子エージェントに見せるツール(read_file/write_file等)は
 * **アプリ自身のプラグイン**を使う(サンドボックスには何も無いので、そこから読んでも空になる)
 */
export class LocalToolJobRunner implements EvolutionJobRunner {
  constructor(
    private readonly createProvider: () => LLMProvider,
    /** アプリのプラグインディレクトリ(同梱+導入済み) */
    private readonly pluginDirs: string[],
    private readonly pluginCacheBase: string = join(tmpdir(), 'amateras-local-evolve-cache'),
  ) {}

  async generate(
    req: EvolutionRequest,
    sandboxDir: string,
    log: (line: string) => void,
    signal: AbortSignal,
    feedback?: string,
  ): Promise<JobArtifacts> {
    const full = new ToolRegistry(this.pluginDirs, join(this.pluginCacheBase, String(Date.now())));
    await full.reload();
    // M91: 配布版で実測。生成エージェントに bash を握らせると、「自分で検証しよう」として
    // `dir` や `npm` を叩き続け(この環境にnpmは無い/制限モードで弾かれる)、ターンを食い潰して
    // 生成が終わらなかった。**要らない道具は渡さない** — 検証はアプリのゲートが本物で回す
    const registry = toolsForGeneration(full);
    const broker = new ApprovalBroker(() => {});

    const taskText =
      req.targetTool !== undefined
        ? `既存ツール「${req.targetTool}」の修正が必要: ${req.description}\n期待する入出力: ${req.expectedIO}\n` +
          `${sandboxDir} 配下の src/main/tools/plugins/${req.targetTool}.ts を読み、直接編集して修正せよ` +
          `(toolNameは「${req.targetTool}」のまま変更しない)。`
        : `新しい能力が必要: ${req.description}\n期待する入出力: ${req.expectedIO}\n` +
          `${sandboxDir} 配下の src/main/tools/plugins/ にプラグイン本体とテストを実装せよ。`;

    // M92-A1: 初回だけ手本(最も近い既存プラグインの全文)を差し込む。
    // 再生成(feedback有り)では既に形は掴めているので付けない(トークンを差分修正に回す)
    const exemplar =
      feedback === undefined
        ? buildExemplarSection(this.pluginDirs, chooseExemplarName(req, exemplarCandidates(full.list()), req.targetTool))
        : '';

    const history: Parameters<typeof runAgentLoop>[2] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              taskText +
              exemplar +
              (feedback
                ? `\n\n【作り直し・最小差分で】前回の生成物は検証ゲートに不合格だった。**全文を書き直すな**。` +
                  `read_file で現状を確認し、edit_file で**指摘された箇所だけ**を直せ(通っている部分は触るな):\n${feedback}`
                : ''),
          },
        ],
      },
    ];

    let lastText = '';
    const status = await runAgentLoop(
      {
        provider: this.createProvider(),
        tools: registry,
        executeTool: (name, input, ctx) =>
          executeToolWithApproval(
            { registry, broker, getAutoApprove: () => ({ safe: true, write: true, exec: false }) },
            name,
            input,
            { ...ctx, writeAllowlist: SCOPE_ALLOWLISTS.tool, restrictExec: true },
          ),
        emit: (e) => {
          if (e.kind === 'text_delta') lastText += e.text;
          if (e.kind === 'message_done') {
            if (lastText.trim()) log(`[job] ${lastText.trim().slice(0, 300)}`);
            lastText = '';
          }
          if (e.kind === 'tool_start') log(`[job] tool: ${e.name} ${e.inputPreview.slice(0, 120)}`);
        },
        systemPrompt: LOCAL_TOOL_JOB_SYSTEM_PROMPT,
        cwd: sandboxDir,
        maxTurns: 30,
      },
      `local-evolve-${Date.now()}`,
      history,
      signal,
    );
    if (status !== 'done') throw new Error(`ツール生成のエージェントが異常終了: ${status}`);

    const finalText = history
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const match = /```json\s*([\s\S]*?)```/.exec(finalText);
    if (!match) throw new Error('生成結果のメタデータ(toolName/smokeInput)が見つからない');
    const meta: unknown = JSON.parse(match[1]!);
    if (typeof meta !== 'object' || meta === null) throw new Error('メタデータ形式が不正');
    const rec = meta as Record<string, unknown>;
    assertSafeToolName(rec['toolName']);
    return { toolName: rec['toolName'], smokeInput: rec['smokeInput'] ?? {} };
  }
}

/**
 * 実LLMで新ツールを生成するジョブランナー(M5で使用)。
 * B worktree を cwd とし、writeAllowlist で書き込み先を機械的に制限した子エージェントセッション。
 */
export class AgentJobRunner implements EvolutionJobRunner {
  constructor(
    private readonly createProvider: () => LLMProvider,
    private readonly pluginCacheBase: string = join(tmpdir(), 'amateras-evolve-cache'),
  ) {}

  async generate(
    req: EvolutionRequest,
    worktreeDir: string,
    log: (line: string) => void,
    signal: AbortSignal,
    feedback?: string,
  ): Promise<JobArtifacts> {
    const scope = req.scope ?? 'tool';
    const allowlist = SCOPE_ALLOWLISTS[scope];
    // B内のプラグインを見せるため、B専用のレジストリを作る
    const registry = new ToolRegistry(
      join(worktreeDir, 'src/main/tools/plugins'),
      join(this.pluginCacheBase, String(Date.now())),
    );
    await registry.reload();
    // 進化ジョブ内のツール実行は全自動承認(昇格時に人間の承認が入るため)
    const broker = new ApprovalBroker(() => {});

    const taskText =
      scope === 'tool'
        ? req.targetTool !== undefined
          ? `既存ツール「${req.targetTool}」の修正が必要: ${req.description}\n期待する入出力: ${req.expectedIO}\n` +
            `まず src/main/tools/plugins/${req.targetTool}.ts と ${req.targetTool}.test.ts を読み、` +
            `このworktree(${worktreeDir})内で既存ファイルを直接編集して修正せよ` +
            `(新しい名前のファイルを作ってはならない。toolNameは「${req.targetTool}」のまま変更しないこと)。`
          : `新しい能力が必要: ${req.description}\n期待する入出力: ${req.expectedIO}\n` +
            `このworktree(${worktreeDir})内でプラグインとテストを実装せよ。`
        : `本体改善の依頼(scope: ${scope}): ${req.description}\n期待する挙動: ${req.expectedIO}\n` +
          `このworktree(${worktreeDir})内の既存コードを最小差分で修正せよ。`;
    // M92-A1: 新規ツール生成の初回だけ、最も近い既存プラグインの全文を手本として差し込む
    // (renderer/core の本体改修は対象外。再生成では付けない=トークンは差分修正へ)
    const exemplar =
      scope === 'tool' && feedback === undefined
        ? buildExemplarSection(
            [join(worktreeDir, 'src/main/tools/plugins')],
            chooseExemplarName(req, exemplarCandidates(registry.list()), req.targetTool),
          )
        : '';
    const history: Parameters<typeof runAgentLoop>[2] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              taskText +
              exemplar +
              (feedback
                ? `\n\n【再生成・最小差分で】前回の生成物は検証ゲートに不合格だった。**全文を書き直すな**。` +
                  `まず read_file で現状を確認し、edit_file で**指摘された箇所だけ**を直せ(通っている部分は触るな):\n${feedback}`
                : ''),
          },
        ],
      },
    ];

    let lastText = '';
    const status = await runAgentLoop(
      {
        provider: this.createProvider(),
        tools: registry,
        executeTool: (name, input, ctx) =>
          executeToolWithApproval(
            {
              registry,
              broker,
              getAutoApprove: () => ({ safe: true, write: true, exec: true }),
            },
            name,
            input,
            { ...ctx, writeAllowlist: allowlist, restrictExec: true },
          ),
        emit: (e) => {
          if (e.kind === 'text_delta') lastText += e.text;
          if (e.kind === 'message_done') {
            if (lastText.trim()) log(`[job] ${lastText.trim().slice(0, 300)}`);
            lastText = '';
          }
          if (e.kind === 'tool_start') log(`[job] tool: ${e.name} ${e.inputPreview.slice(0, 120)}`);
        },
        systemPrompt: scope === 'tool' ? JOB_SYSTEM_PROMPT : CORE_JOB_SYSTEM_PROMPT(scope, allowlist),
        cwd: worktreeDir,
        maxTurns: scope === 'tool' ? 40 : 60,
      },
      `evolve-${Date.now()}`,
      history,
      signal,
    );

    if (status !== 'done') throw new Error(`進化ジョブのエージェントが異常終了: ${status}`);

    // 最終応答から成果物メタデータ(toolName / smokeInput)を抽出
    const finalText = history
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const match = /```json\s*([\s\S]*?)```/.exec(finalText);
    if (!match) throw new Error('生成結果のメタデータ(toolName/summary)が見つからない');
    const meta: unknown = JSON.parse(match[1]!);
    if (typeof meta !== 'object' || meta === null) {
      throw new Error('メタデータ形式が不正');
    }
    const rec = meta as Record<string, unknown>;

    if (scope !== 'tool') {
      // renderer/core: 変更概要のみ(toolName無し。スモークはフルアプリ起動が担う)
      if (typeof rec['summary'] !== 'string' || rec['summary'].trim() === '') {
        throw new Error('renderer/core ジョブは summary(変更概要)が必要');
      }
      return { summary: rec['summary'] };
    }

    // toolName はこの後シェルコマンドへ補間される(gates/supervisor)ため厳格に検証する
    assertSafeToolName(rec['toolName']);
    return {
      toolName: rec['toolName'],
      smokeInput: rec['smokeInput'] ?? {},
    };
  }
}
