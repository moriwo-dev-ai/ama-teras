import type { LLMProvider } from '../providers/types';
import { runAgentLoop } from '../agent/loop';
import { executeToolWithApproval } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import { ApprovalBroker } from '../agent/approval';
import { assertSafeToolName } from '../tools/name';
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

プラグイン規約:
- export default { name, description, inputSchema, risk, tags?, warnings?, execute } satisfies ToolPlugin
- name はファイル名と一致(修正時は絶対に変えない)
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

最後の応答で、ツール名とスモークテスト用のサンプル入力JSONを
\`\`\`json {"toolName": "...", "smokeInput": {...}} \`\`\` のコードブロックで必ず出力する`;

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
    const registry = new ToolRegistry(this.pluginDirs, join(this.pluginCacheBase, String(Date.now())));
    await registry.reload();
    const broker = new ApprovalBroker(() => {});

    const taskText =
      req.targetTool !== undefined
        ? `既存ツール「${req.targetTool}」の修正が必要: ${req.description}\n期待する入出力: ${req.expectedIO}\n` +
          `${sandboxDir} 配下の src/main/tools/plugins/${req.targetTool}.ts を読み、直接編集して修正せよ` +
          `(toolNameは「${req.targetTool}」のまま変更しない)。`
        : `新しい能力が必要: ${req.description}\n期待する入出力: ${req.expectedIO}\n` +
          `${sandboxDir} 配下の src/main/tools/plugins/ にプラグイン本体とテストを実装せよ。`;

    const history: Parameters<typeof runAgentLoop>[2] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              taskText +
              (feedback
                ? `\n\n【作り直し】前回の生成物は検証ゲートに不合格だった。既存ファイルを修正して直せ:\n${feedback}`
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
    const history: Parameters<typeof runAgentLoop>[2] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              taskText +
              (feedback
                ? `\n\n【再生成】前回の生成物は検証ゲートに不合格だった。既存ファイルを修正して直せ:\n${feedback}`
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
