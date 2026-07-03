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
}

export interface JobArtifacts {
  /** 生成された新ツール名(スモークテスト対象) */
  toolName: string;
  /** スモークテスト用サンプル入力 */
  smokeInput: unknown;
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

/** 書き込み許可: プラグインと同ディレクトリのテストのみ(ARCHITECTURE §6.2) */
export const EVOLUTION_WRITE_ALLOWLIST = ['src/main/tools/plugins'];

const JOB_SYSTEM_PROMPT = `あなたはMyCodexの進化ジョブ。新しいツールプラグインを1つ実装する。

厳守事項:
- 書き込みは src/main/tools/plugins/ 配下のみ許可されている(機械的にも強制される)
- 成果物: (1) src/main/tools/plugins/<name>.ts のプラグイン本体
  (2) src/main/tools/plugins/<name>.test.ts のvitestユニットテスト
- プラグイン規約: export default { name, description, inputSchema, risk, warnings?, execute } satisfies ToolPlugin。
  name はファイル名と一致。型は import type { ToolPlugin, ToolContext, ToolResult } from '../types' で参照。
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
 * 実LLMで新ツールを生成するジョブランナー(M5で使用)。
 * B worktree を cwd とし、writeAllowlist で書き込み先を機械的に制限した子エージェントセッション。
 */
export class AgentJobRunner implements EvolutionJobRunner {
  constructor(
    private readonly createProvider: () => LLMProvider,
    private readonly pluginCacheBase: string = join(tmpdir(), 'mycodex-evolve-cache'),
  ) {}

  async generate(
    req: EvolutionRequest,
    worktreeDir: string,
    log: (line: string) => void,
    signal: AbortSignal,
    feedback?: string,
  ): Promise<JobArtifacts> {
    // B内のプラグインを見せるため、B専用のレジストリを作る
    const registry = new ToolRegistry(
      join(worktreeDir, 'src/main/tools/plugins'),
      join(this.pluginCacheBase, String(Date.now())),
    );
    await registry.reload();
    // 進化ジョブ内のツール実行は全自動承認(昇格時に人間の承認が入るため)
    const broker = new ApprovalBroker(() => {});

    const history: Parameters<typeof runAgentLoop>[2] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `新しい能力が必要: ${req.description}\n期待する入出力: ${req.expectedIO}\n` +
              `このworktree(${worktreeDir})内でプラグインとテストを実装せよ。` +
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
            { ...ctx, writeAllowlist: EVOLUTION_WRITE_ALLOWLIST, restrictExec: true },
          ),
        emit: (e) => {
          if (e.kind === 'text_delta') lastText += e.text;
          if (e.kind === 'message_done') {
            if (lastText.trim()) log(`[job] ${lastText.trim().slice(0, 300)}`);
            lastText = '';
          }
          if (e.kind === 'tool_start') log(`[job] tool: ${e.name} ${e.inputPreview.slice(0, 120)}`);
        },
        systemPrompt: JOB_SYSTEM_PROMPT,
        cwd: worktreeDir,
        maxTurns: 40,
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
    if (!match) throw new Error('生成結果のメタデータ(toolName/smokeInput)が見つからない');
    const meta: unknown = JSON.parse(match[1]!);
    if (typeof meta !== 'object' || meta === null) {
      throw new Error('メタデータ形式が不正');
    }
    const rec = meta as Record<string, unknown>;
    // toolName はこの後シェルコマンドへ補間される(gates/supervisor)ため厳格に検証する
    assertSafeToolName(rec['toolName']);
    return {
      toolName: rec['toolName'],
      smokeInput: rec['smokeInput'] ?? {},
    };
  }
}
