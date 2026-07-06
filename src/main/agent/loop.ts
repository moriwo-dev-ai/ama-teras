import type { AgentEvent, AgentStatus } from '../../shared/types';
import type { ChatMessage, ContentBlock, LLMProvider, ToolDefinition } from '../providers/types';
import type { ToolContext, ToolPlugin, ToolResult } from '../tools/types';
import { classifyLLMError, shortLLMError } from './llmErrors';

export interface AgentLoopDeps {
  provider: LLMProvider;
  /** ToolRegistry を構造的に満たす(テストではモック可能) */
  tools: { list(): ToolPlugin[] };
  /** 承認フロー込みのツール実行(tools/executor.ts の executeToolWithApproval を束ねたもの) */
  executeTool: (name: string, input: unknown, ctx: ToolContext) => Promise<ToolResult>;
  emit: (event: AgentEvent) => void;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
  maxTokens?: number;
  /** プランモード: ツールを一切実行しない(計画提示のみ)。承認前の実行を機械的に防ぐ(M8-3) */
  planMode?: boolean;
  /**
   * M13-1: ループ内 compaction フック。直近APIコールの実測プロンプトトークン
   * (input + cache_read)を渡して呼ばれる。長い自走の途中でも履歴を圧縮できる。
   * 失敗しても次のターンへ進む(呼び出し側で握る)
   */
  compact?: (measuredPromptTokens: number) => Promise<void>;
  /**
   * M16-1: 実測プロンプトトークンの通知(message_doneごと)。compact と違い
   * 1ターン完結でも呼ばれる — 呼び出し側が「最後の実測値」を保持するために使う
   */
  onUsage?: (measuredPromptTokens: number) => void;
  /** M16-2: 一時エラーのリトライ設定(テスト用にbaseMsを注入可能。既定 3回・1秒起点) */
  retry?: { maxRetries?: number; baseMs?: number };
  /**
   * M16-2: 課金系エラー(残高枯渇等)時のフォールバック取得。新しいプロバイダを返せば
   * 同一ターンから続行、null なら従来どおり error 停止。1セッション1回の制限・
   * 事前compaction・監査記録は呼び出し側(AgentService)が担う
   */
  acquireFallback?: (reason: string) => Promise<LLMProvider | null>;
  /**
   * M21-1: 実行中に積まれた追加指示のdrain。各ターンのLLM呼び出し前に呼ばれ、
   * 返った指示は直前の user メッセージ(tool_result群)の末尾へ text/image ブロックとして
   * 追記される(tool_use/tool_result の対を壊さない)。モデルが応答を完了した時点で
   * 残っていた指示は、新しい user メッセージとして積まれループが継続する
   */
  drainInstructions?: () => { text: string; images?: { mediaType: string; data: string; description?: string }[] }[];
}

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_TOKENS = 32_000;

function toToolDefinitions(plugins: ToolPlugin[]): ToolDefinition[] {
  return plugins.map((p) => ({ name: p.name, description: p.description, inputSchema: p.inputSchema }));
}

function preview(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

/** 実行されなかった tool_use を履歴上で閉じるための合成 tool_result(整合性維持用) */
function syntheticToolResult(toolUseId: string, reason: string): Extract<ContentBlock, { type: 'tool_result' }> {
  return { type: 'tool_result', toolUseId, content: reason, isError: true };
}

/**
 * エージェントループ本体: 応答 → tool_use → 承認+実行 → tool_result → ループ。
 * history は呼び出し側が保持し、この関数が assistant / tool_result メッセージを追記する。
 * 戻り値は終了ステータス(emit済みのものと同じ)。
 */
export async function runAgentLoop(
  deps: AgentLoopDeps,
  sessionId: string,
  history: ChatMessage[],
  signal: AbortSignal,
): Promise<AgentStatus> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const finish = (status: AgentStatus): AgentStatus => {
    deps.emit({ kind: 'status', sessionId, status });
    return status;
  };

  let lastPromptTokens = 0;
  // M16-2: フォールバック発動後はこのプロバイダで続行する
  let provider = deps.provider;
  const maxRetries = deps.retry?.maxRetries ?? 3;
  const retryBaseMs = deps.retry?.baseMs ?? 1000;

  /**
   * M21-1: 追加指示の注入。直前が user メッセージ(tool_result群 or 初回指示)なら
   * その末尾へ追記(tool_result が先・text が後の並びはAPI仕様上有効)、
   * そうでなければ新しい user メッセージとして積む。戻り値=注入したか
   */
  const injectQueuedInstructions = (): boolean => {
    const items = deps.drainInstructions?.() ?? [];
    if (items.length === 0) return false;
    const blocks: ContentBlock[] = [];
    for (const item of items) {
      blocks.push({ type: 'text', text: item.text });
      for (const img of item.images ?? []) blocks.push({ type: 'image', ...img });
    }
    const last = history[history.length - 1];
    if (last && last.role === 'user') last.content.push(...blocks);
    else history.push({ role: 'user', content: blocks });
    return true;
  };

  const sleepUnlessAborted = (ms: number): Promise<void> =>
    new Promise((resolvePromise) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        resolvePromise();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal.aborted) return finish('cancelled');
    // M13-1: 前ターンの実測トークンでループ内compaction(閾値判定は呼び出し側)
    if (turn > 0 && deps.compact && lastPromptTokens > 0) {
      await deps.compact(lastPromptTokens);
    }
    // M21-1: ターン境界(LLM呼び出しの前)で追加指示を履歴へ注入する
    injectQueuedInstructions();
    deps.emit({ kind: 'status', sessionId, status: 'calling_llm' });

    let finalMessage: ChatMessage | null = null;
    let stopReason = 'other';

    // M16-2: 一時エラーは指数バックオフでリトライ、課金系はフォールバック(1回)を試みる
    let retriesUsed = 0;
    for (;;) {
      finalMessage = null;
      stopReason = 'other';
      try {
        for await (const ev of provider.complete({
          system: deps.systemPrompt,
          messages: history,
          tools: toToolDefinitions(deps.tools.list()),
          maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
          signal,
        })) {
          switch (ev.type) {
            case 'text_delta':
              deps.emit({ kind: 'text_delta', sessionId, text: ev.text });
              break;
            case 'message_done':
              finalMessage = ev.message;
              stopReason = ev.stopReason;
              // M13-1: プロンプト側の実測トークン(圧縮トリガーの判定材料)
              lastPromptTokens = ev.usage.inputTokens + ev.usage.cacheReadTokens;
              deps.onUsage?.(lastPromptTokens);
              // prompt caching の効き(cacheReadTokens)を実測できる唯一の場所。mainログに残す
              console.log(
                `[usage] session=${sessionId} turn=${turn} in=${ev.usage.inputTokens} out=${ev.usage.outputTokens} cache_read=${ev.usage.cacheReadTokens}`,
              );
              break;
            default:
              break;
          }
        }
        break; // 成功
      } catch (err) {
        if (signal.aborted) return finish('cancelled');
        const kind = classifyLLMError(err);

        if (kind === 'transient' && retriesUsed < maxRetries) {
          retriesUsed++;
          const delay = retryBaseMs * 2 ** (retriesUsed - 1);
          deps.emit({
            kind: 'info',
            sessionId,
            message: `一時的なAPIエラーのため再試行します(${retriesUsed}/${maxRetries}、${Math.round(delay / 1000)}秒待機): ${shortLLMError(err)}`,
          });
          await sleepUnlessAborted(delay);
          if (signal.aborted) return finish('cancelled');
          continue;
        }

        if (kind === 'billing' && deps.acquireFallback) {
          const fallback = await deps.acquireFallback(shortLLMError(err));
          if (signal.aborted) return finish('cancelled');
          if (fallback) {
            provider = fallback;
            retriesUsed = 0;
            continue; // 同一ターンをフォールバック先でやり直す
          }
        }

        deps.emit({
          kind: 'error',
          sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
        return finish('error');
      }
    }

    if (signal.aborted) return finish('cancelled');
    if (!finalMessage || finalMessage.content.length === 0) {
      deps.emit({
        kind: 'error',
        sessionId,
        message: stopReason === 'refusal' ? 'モデルが応答を拒否した' : 'モデル応答が空だった',
      });
      return finish('error');
    }

    history.push(finalMessage);
    deps.emit({ kind: 'message_done', sessionId });

    // tool_use が1つでも積まれたら、対応する tool_result を必ず同数返さないと
    // 次リクエストで API が 400 を返し履歴が恒久破損する。実行有無に関わらず整合を保つ。
    const toolUses = finalMessage.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );

    if (stopReason !== 'tool_use') {
      // max_tokens 等で応答が途中終了しつつ tool_use ブロックを含む場合、
      // それらを合成 tool_result で閉じてから終了する(未応答 tool_use を残さない)。
      if (toolUses.length > 0) {
        history.push({
          role: 'user',
          content: toolUses.map((tu) => syntheticToolResult(tu.id, '応答が途中で終了したためツールは実行されなかった')),
        });
      }
      if (stopReason === 'max_tokens') {
        deps.emit({ kind: 'error', sessionId, message: '出力トークン上限に達した(応答は途中で切れている)' });
        return finish('done');
      }
      // M21-1: 応答完了の時点で追加指示が残っていたら、新しい user メッセージとして
      // 積んでループを継続する(指示の取りこぼし禁止)
      if (injectQueuedInstructions()) continue;
      return finish('done');
    }

    // tool_use ブロックを順に実行し、結果を1つの user メッセージにまとめて返す
    const results: ContentBlock[] = [];
    let cancelledMidLoop = false;
    for (const tu of toolUses) {
      if (signal.aborted) {
        cancelledMidLoop = true;
        break;
      }
      // プランモードでは承認前のツール実行を機械的に禁止する(計画のみ提示)
      if (deps.planMode) {
        const msg = 'プランモードのためツールは実行しない。計画を提示し、ユーザーの承認を待て。';
        results.push({ type: 'tool_result', toolUseId: tu.id, content: msg, isError: true });
        continue;
      }
      // 引数JSONの解析に失敗したツールは実行せず、原因をモデルとUIに明示して返す
      // (空入力での実行は無関係なバリデーションエラーを招きモデルがループするため)
      if (tu.inputError) {
        deps.emit({ kind: 'error', sessionId, message: `${tu.name}: ${tu.inputError}` });
        deps.emit({
          kind: 'tool_result',
          sessionId,
          toolUseId: tu.id,
          name: tu.name,
          content: tu.inputError,
          isError: true,
        });
        results.push({ type: 'tool_result', toolUseId: tu.id, content: tu.inputError, isError: true });
        continue;
      }
      deps.emit({
        kind: 'tool_start',
        sessionId,
        toolUseId: tu.id,
        name: tu.name,
        inputPreview: preview(tu.input),
      });
      deps.emit({ kind: 'status', sessionId, status: 'executing_tool' });
      const result = await deps.executeTool(tu.name, tu.input, {
        cwd: deps.cwd,
        signal,
        log: () => {},
      });
      deps.emit({
        kind: 'tool_result',
        sessionId,
        toolUseId: tu.id,
        name: tu.name,
        content: result.content.length > 2000 ? `${result.content.slice(0, 2000)}…` : result.content,
        isError: result.isError === true,
        // M14-3: UIサムネイル用(data URL)
        ...(result.images && result.images.length > 0
          ? { images: result.images.map((i) => `data:${i.mediaType};base64,${i.data}`) }
          : {}),
      });
      results.push({
        type: 'tool_result',
        toolUseId: tu.id,
        content: result.content,
        isError: result.isError,
        // M14-1: 画像付きツール結果(screenshot等)をモデルへ渡す
        ...(result.images && result.images.length > 0 ? { images: result.images } : {}),
      });
    }
    // キャンセルで未実行のまま抜けた tool_use にも合成結果を対応させ、履歴を整合させてから閉じる
    for (const tu of toolUses.slice(results.length)) {
      results.push(syntheticToolResult(tu.id, 'ユーザーによりキャンセルされたためツールは実行されなかった'));
    }
    history.push({ role: 'user', content: results });
    if (cancelledMidLoop || signal.aborted) return finish('cancelled');
  }

  return finish('max_turns_reached');
}
