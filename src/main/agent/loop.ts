import type { AgentEvent, AgentStatus } from '../../shared/types';
import type { ChatMessage, ContentBlock, LLMProvider, ToolDefinition } from '../providers/types';
import type { ToolContext, ToolPlugin, ToolResult } from '../tools/types';
import { classifyLLMError, retryAfterMs, shortLLMError } from './llmErrors';

/** M113-1: 一晩モードの段階待機(retry-after が取れないときの既定)。30秒→…→15分上限 */
export const PATIENCE_WAITS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];
/** M113-1: 一晩モードの通算待機上限(これを超えたら諦めて error 停止)。既定12時間 */
export const PATIENCE_MAX_TOTAL_MS = 12 * 60 * 60 * 1000;

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
   * M113-1: 一晩モード(忍耐リトライ)。enabled のとき transient エラーは maxRetries を
   * 使い切っても諦めず、待って再試行し続ける。待機時間は retry-after(取れれば)と
   * 段階スケジュール(waitScheduleMs、テスト注入可)の大きい方。通算待機が
   * maxTotalWaitMs(既定12時間)を超えたら従来どおり error 停止。
   * 狙い: 無料枠APIの「分/日あたり制限」は速度制限であって総量制限ではない —
   * ペースを落として完走する(関門1「APIキーと従量課金」対策の中核)
   */
  patience?: { enabled: boolean; maxTotalWaitMs?: number; waitScheduleMs?: number[] };
  /**
   * M113-2: 一晩モードの待機に入るたびに呼ばれる(再開予定時刻ms)。
   * 呼び出し側が「待機中に落ちても再開できる印」を永続化するために使う
   */
  onPatientWait?: (resumeAtMs: number) => void;
  /**
   * M16-2: 課金系エラー(残高枯渇等)時のフォールバック取得。新しいプロバイダを返せば
   * 同一ターンから続行、null なら従来どおり error 停止。1セッション1回の制限・
   * 事前compaction・監査記録は呼び出し側(AgentService)が担う。
   * M26-4: kind='refusal' はセーフガード拒否(stop_reason='refusal')からの復帰要求。
   * billing の「1会話1回」とは別枠のカウンタ(1会話2回まで)を呼び出し側が管理する
   */
  acquireFallback?: (
    reason: string,
    kind?: 'billing' | 'refusal' | 'model_unavailable',
  ) => Promise<LLMProvider | null>;
  /**
   * M27-1: 停止時のLLMエラーをユーザー向けの平易な文言へ差し替えるフック。
   * null を返せば従来どおり生のエラーメッセージを表示する
   * (無料APIモードの429を「無料枠の上限に達しました…」等にするために使う)。
   * M30-2: オブジェクト形式なら settingsHint(エラーカードから設定を開く導線)も渡せる
   */
  describeLLMError?: (err: unknown) => string | { message: string; settingsHint?: 'models' | 'basic' } | null;
  /**
   * M21-1: 実行中に積まれた追加指示のdrain。各ターンのLLM呼び出し前に呼ばれ、
   * 返った指示は直前の user メッセージ(tool_result群)の末尾へ text/image ブロックとして
   * 追記される(tool_use/tool_result の対を壊さない)。モデルが応答を完了した時点で
   * 残っていた指示は、新しい user メッセージとして積まれループが継続する
   */
  drainInstructions?: () => { text: string; images?: { mediaType: string; data: string; description?: string }[] }[];
  /**
   * M124: 待機中断用の覗き見(残数のみ・消費しない)。一晩モードの忍耐待機中に
   * ユーザーが割り込んだら、待機を切り上げて即座にターン境界へ戻るために使う
   */
  peekInstructionCount?: () => number;
  /**
   * M92-B3: ループ検出(道具に関係なく暴走を止める汎用ネット)。同一ツール+同一引数の
   * 呼び出しが maxIdenticalCalls 回を超えたら、それ以上は実行せず「手を変えるか完了せよ」と
   * 促す(nudge=tool_result)。進捗の無いブロックが hardStopAfterBlocked 回続いたらターンを
   * 打ち切る。既定は 3 / 3。生成エージェント(bashループ再発防止)にも本体にも効く。
   */
  loopGuard?: { maxIdenticalCalls?: number; hardStopAfterBlocked?: number };
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

/** M92-B3: キー順に依存しない安定した文字列化(同一引数の判定に使う) */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(',')}}`;
}

/** ツール名+引数の同一性シグネチャ(\x00区切りで名前と引数の衝突を避ける) */
function callSignature(name: string, input: unknown): string {
  return `${name}\x00${stableStringify(input)}`;
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
  // M113-1: 一晩モードの通算待機(run全体で数える。ターンを跨いでも減らない)
  const patient = deps.patience?.enabled === true;
  const patienceWaits = deps.patience?.waitScheduleMs ?? PATIENCE_WAITS_MS;
  const patienceMaxTotalMs = deps.patience?.maxTotalWaitMs ?? PATIENCE_MAX_TOTAL_MS;
  let patientWaitedMs = 0;
  let patientRetries = 0;

  // M92-B3: ループ検出。実行した (ツール名+引数) の回数を run 全体で数える。
  // 同一シグネチャが上限を超えたら実行せず nudge、進捗の無いブロックが続けば打ち切る
  const maxIdenticalCalls = deps.loopGuard?.maxIdenticalCalls ?? 3;
  const hardStopAfterBlocked = deps.loopGuard?.hardStopAfterBlocked ?? 3;
  const callCounts = new Map<string, number>();
  let blockedInARow = 0;

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

  /**
   * M124: 忍耐待機用スリープ。1秒刻みで待ち、ユーザーの割り込みチャットが届いたら
   * 'interrupted' で早期復帰する(2026-08-05 実害: 429待機が15分に伸びると、割り込みが
   * キューに溜まったまま「戻ってこない=再起動が必要」に見えた)
   */
  const sleepPatiently = async (ms: number): Promise<'slept' | 'interrupted'> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (signal.aborted) return 'slept';
      if ((deps.peekInstructionCount?.() ?? 0) > 0) return 'interrupted';
      await sleepUnlessAborted(Math.min(1000, until - Date.now()));
    }
    return 'slept';
  };

  turns: for (let turn = 0; turn < maxTurns; turn++) {
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
        // M26-4: セーフガード拒否(stop_reason='refusal')は HTTP 200 の正常応答として届く。
        // acquireFallback があれば代替プロバイダで同一ターンをやり直す(呼び出し側が
        // billing とは別枠の「1会話2回まで」カウンタを管理)。無し/上限なら下の空応答扱いへ
        if (stopReason === 'refusal' && deps.acquireFallback) {
          const fallback = await deps.acquireFallback('モデルが応答を拒否した(セーフガード)', 'refusal');
          if (signal.aborted) return finish('cancelled');
          if (fallback) {
            deps.emit({
              kind: 'info',
              sessionId,
              message: 'セーフガードによる応答拒否を検知したため、代替モデルで同一ターンをやり直します',
            });
            provider = fallback;
            retriesUsed = 0;
            continue;
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

        // M113-1: 一晩モード — 通常リトライを使い切った transient は「失敗」ではなく「待機」。
        // retry-after が取れればそれを尊重し、無ければ段階スケジュールで粘る
        if (kind === 'transient' && patient && patientWaitedMs < patienceMaxTotalMs) {
          patientRetries++;
          const scheduled = patienceWaits[Math.min(patientRetries - 1, patienceWaits.length - 1)] ?? 0;
          const delay = Math.max(retryAfterMs(err) ?? 0, scheduled);
          patientWaitedMs += delay;
          const resumeAtMs = Date.now() + delay;
          const eta = new Date(resumeAtMs);
          const hh = String(eta.getHours()).padStart(2, '0');
          const mm = String(eta.getMinutes()).padStart(2, '0');
          deps.onPatientWait?.(resumeAtMs);
          deps.emit({
            kind: 'info',
            sessionId,
            message: `🌙 一晩モード: 無料枠の回復を待っています(次の再試行 ${hh}:${mm}・通算${patientRetries}回目・${shortLLMError(err)})`,
          });
          const how = await sleepPatiently(delay);
          if (signal.aborted) return finish('cancelled');
          if (how === 'interrupted') {
            deps.emit({ kind: 'info', sessionId, message: '💬 割り込みを受けたため待機を中断して応答します' });
            continue turns; // ターン境界へ(そこで割り込みが履歴に注入され、即座にLLMを呼び直す)
          }
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

        // M30-2: モデル未開放/不存在(404)。同一プロバイダの既知の安定モデルへ
        // 切り替えて続行を試みる(1会話1回・呼び出し側が警告カード+audit記録)
        if (kind === 'model_unavailable' && deps.acquireFallback) {
          const fallback = await deps.acquireFallback(shortLLMError(err), 'model_unavailable');
          if (signal.aborted) return finish('cancelled');
          if (fallback) {
            provider = fallback;
            retriesUsed = 0;
            continue;
          }
        }

        const described = deps.describeLLMError?.(err) ?? null;
        deps.emit({
          kind: 'error',
          sessionId,
          message:
            described === null
              ? err instanceof Error
                ? err.message
                : String(err)
              : typeof described === 'string'
                ? described
                : described.message,
          ...(typeof described === 'object' && described !== null && described.settingsHint !== undefined
            ? { settingsHint: described.settingsHint }
            : {}),
        });
        return finish('error');
      }
    }

    if (signal.aborted) return finish('cancelled');
    // M26-4: フォールバック不発の refusal は部分出力があっても信頼できないため error 停止
    if (stopReason === 'refusal' || !finalMessage || finalMessage.content.length === 0) {
      deps.emit({
        kind: 'error',
        sessionId,
        message:
          stopReason === 'refusal'
            ? 'モデルが応答を拒否した(セーフガード)。フォールバック未設定または上限のため停止'
            : 'モデル応答が空だった',
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
      // M92-B3: ループ検出。同一ツール+同一引数が maxIdenticalCalls 回を超えたら、
      // 実行せずに「同じ結果しか返らない。手を変えるか完了せよ」と促す(nudge)。
      // 実行(=進捗)に進めば blockedInARow をリセット、ブロックが続けば下で打ち切る。
      const sig = callSignature(tu.name, tu.input);
      const priorCount = callCounts.get(sig) ?? 0;
      if (priorCount >= maxIdenticalCalls) {
        blockedInARow++;
        const nudge =
          `⚠ ループ検出: ${tu.name} を同じ引数で ${priorCount} 回呼んでいる。同じ結果しか返らないため実行を打ち切った。` +
          `**手を変えるか、ここまでの結果で完了せよ**(同じ呼び出しを繰り返しても状況は変わらない)。`;
        deps.emit({
          kind: 'info',
          sessionId,
          message: `ループ検出により ${tu.name} の実行を打ち切った(同一呼び出し ${priorCount} 回)`,
        });
        deps.emit({ kind: 'tool_result', sessionId, toolUseId: tu.id, name: tu.name, content: nudge, isError: true });
        results.push({ type: 'tool_result', toolUseId: tu.id, content: nudge, isError: true });
        continue;
      }
      callCounts.set(sig, priorCount + 1);
      blockedInARow = 0; // 実行に進む=進捗。ブロック連鎖をリセットする
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
        // M21-4: ツールのライブ出力(bashのstdout末尾等)をUIへ流す
        log: (message: string) =>
          deps.emit({ kind: 'tool_progress', sessionId, toolUseId: tu.id, name: tu.name, outputTail: message }),
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
    // M92-B3: 進捗の無い(同一呼び出しのブロックだけの)状態が続いたら打ち切る。
    // nudge を無視して同じ呼び出しを繰り返すモデルに対する最後の歯止め。
    if (blockedInARow >= hardStopAfterBlocked) {
      deps.emit({
        kind: 'error',
        sessionId,
        message: `ループ検出: 同じツール呼び出しの繰り返しが続き、進捗が無いため停止した(手を変えられなかった)。`,
      });
      console.log(`[loop-guard] session=${sessionId} hard stop after ${blockedInARow} blocked identical calls`);
      return finish('error');
    }
  }

  return finish('max_turns_reached');
}
