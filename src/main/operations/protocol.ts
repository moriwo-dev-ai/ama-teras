import { randomUUID } from 'node:crypto';
import type { AdapterCapabilities, IwatoRequestPayload, MediaAdapter } from '../../shared/types';

/**
 * M32-2: Protocol AMANO-iwate — 外部媒体アダプタ規約+岩戸ゲート。
 *
 * 【大原則(OPERATIONS_DESIGN.md・変更禁止)】
 * 自動化するのは「観測・分析・発見・下書き・提示」まで。
 * 外部への発信(投稿・コメント・フォロー・マージ)は人間の承認後にのみ実行する。
 *
 * 【岩戸の掟(このファイルが構造的に強制する)】
 * - execute系は全アダプタ共通の承認フロー(何を・どこへ・全文プレビュー)を必ず通る
 * - 承認なし実行はコードレベルで不可能: executor はこのモジュール内の WeakMap に
 *   封印され、IwatoGate.requestExecute(承認フロー込み)以外から到達できない。
 *   アダプタ登録時に executor 参照は AdapterRuntime から切り離される(delete)
 * - 全実行(承認・拒否含む)を audit 記録する
 *
 * このファイルは聖域(PROTECTED_PATHS)に含まれる。
 */

/** アダプタの実行関数。承認済みアクションのみが渡ってくる */
export type AdapterExecutor = (
  action: string,
  params: Record<string, unknown>,
) => Promise<string>;

/** アダプタ実装が register 時に渡す形。executor は登録と同時にゲート内へ封印される */
export interface AdapterRuntime extends MediaAdapter {
  /** 到達性チェック(gh未検出・API不達などを状態表示に使う) */
  availability?: () => Promise<{ available: boolean; detail?: string }>;
  /** capabilities.execute が空でないアダプタは必須。空のアダプタは持ってはならない */
  executor?: AdapterExecutor;
}

export interface IwatoAuditEvent {
  kind: 'operations-execute';
  adapterId: string;
  action: string;
  target: string;
  approved: boolean;
  detail: string;
  [key: string]: unknown;
}

export interface IwatoExecuteResult {
  ok: boolean;
  detail: string;
}

/** 承認プロンプト: UIに承認ダイアログを出し、ユーザーの判断を返す */
export type IwatoApprovalPrompt = (req: IwatoRequestPayload) => Promise<boolean>;

/** executor の封印庫。モジュール外から参照経路が存在しない */
const sealedExecutors = new WeakMap<IwatoGate, Map<string, AdapterExecutor>>();

export class IwatoGate {
  private readonly adapters = new Map<string, AdapterRuntime>();

  constructor(
    private readonly approvalPrompt: IwatoApprovalPrompt,
    private readonly audit: (event: IwatoAuditEvent) => void,
  ) {
    sealedExecutors.set(this, new Map());
  }

  /**
   * アダプタ登録。宣言(capabilities.execute)と実装(executor)の一致を強制する:
   * - execute宣言あり×executor無し → 登録拒否(実行できない宣言は嘘)
   * - execute宣言なし×executorあり → 登録拒否(宣言外の実行能力は闇ルート)
   * 登録後、runtime.executor は削除され、封印庫経由でのみ呼び出せる。
   */
  register(runtime: AdapterRuntime): void {
    const declared = runtime.capabilities.execute;
    if (declared.length > 0 && runtime.executor === undefined) {
      throw new Error(`アダプタ ${runtime.id}: execute宣言があるのに executor が無い`);
    }
    if (declared.length === 0 && runtime.executor !== undefined) {
      throw new Error(`アダプタ ${runtime.id}: execute宣言が空なのに executor を持っている`);
    }
    if (this.adapters.has(runtime.id)) {
      throw new Error(`アダプタ ${runtime.id}: 二重登録`);
    }
    if (runtime.executor !== undefined) {
      sealedExecutors.get(this)?.set(runtime.id, runtime.executor);
    }
    // 封印: ゲートが保持する runtime からも、呼び出し元が持つ参照からも executor を消す
    delete runtime.executor;
    this.adapters.set(runtime.id, runtime);
  }

  /** アダプタ宣言の一覧(UI状態表示用。executor は含まれない) */
  list(): MediaAdapter[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      capabilities: { ...a.capabilities, execute: [...a.capabilities.execute] },
      compliance: a.compliance,
    }));
  }

  /** 到達性チェック付きの状態一覧 */
  async status(): Promise<
    { id: string; capabilities: AdapterCapabilities; compliance: string; available: boolean; detail?: string }[]
  > {
    const out = [];
    for (const a of this.adapters.values()) {
      const avail = a.availability
        ? await a.availability().catch((e: unknown) => ({
            available: false,
            detail: e instanceof Error ? e.message : String(e),
          }))
        : { available: true };
      out.push({
        id: a.id,
        capabilities: { ...a.capabilities, execute: [...a.capabilities.execute] },
        compliance: a.compliance,
        available: avail.available,
        ...(avail.detail !== undefined ? { detail: avail.detail } : {}),
      });
    }
    return out;
  }

  /**
   * M39: 同一アダプタ・同一アクションの複数件を「1回の承認ダイアログ」で通す。
   * 掟は緩めない — ダイアログには全件の全文プレビューを並べる(何を・どこへ・全文)。
   * 承認は1回だが、実行・audit は1件ずつ。1件失敗しても残りは続行し、成否を返す
   * (部分成功を「全部成功」に見せない)。
   */
  async requestExecuteMany(
    adapterId: string,
    action: string,
    items: { id: string; target: string; preview: string; params: Record<string, unknown> }[],
  ): Promise<{ approved: boolean; results: { id: string; target: string; ok: boolean; detail: string }[] }> {
    if (items.length === 0) return { approved: false, results: [] };
    const adapter = this.adapters.get(adapterId);
    const denied = (detail: string): { approved: boolean; results: { id: string; target: string; ok: boolean; detail: string }[] } => {
      for (const it of items) {
        this.audit({ kind: 'operations-execute', adapterId, action, target: it.target, approved: false, detail });
      }
      return { approved: false, results: items.map((it) => ({ id: it.id, target: it.target, ok: false, detail })) };
    };
    if (!adapter) return denied(`未登録のアダプタ: ${adapterId}`);
    if (!adapter.capabilities.execute.includes(action)) {
      return denied('capabilities.execute に無いアクション(拒否)');
    }

    const request: IwatoRequestPayload = {
      id: randomUUID(),
      adapterId,
      action,
      target: `${items.length}件: ${items.map((i) => i.target).join(' / ')}`,
      // 全件の全文を並べる(1件でも読めない状態で承認させない)
      preview: items
        .map((i, n) => `── ${n + 1}/${items.length}: ${i.target} ──\n${i.preview}`)
        .join('\n\n'),
      compliance: adapter.compliance,
    };
    const approved = await this.approvalPrompt(request);
    if (!approved) return denied('ユーザーが承認しなかった(一括)');

    const executor = sealedExecutors.get(this)?.get(adapterId);
    if (!executor) return denied(`アダプタ ${adapterId} に executor が無い(内部不整合)`);

    const results: { id: string; target: string; ok: boolean; detail: string }[] = [];
    for (const it of items) {
      try {
        const detail = await executor(action, it.params);
        this.audit({ kind: 'operations-execute', adapterId, action, target: it.target, approved: true, detail });
        results.push({ id: it.id, target: it.target, ok: true, detail });
      } catch (err) {
        const detail = `実行失敗: ${err instanceof Error ? err.message : String(err)}`;
        this.audit({ kind: 'operations-execute', adapterId, action, target: it.target, approved: true, detail });
        results.push({ id: it.id, target: it.target, ok: false, detail });
      }
    }
    return { approved: true, results };
  }

  /**
   * 岩戸ゲート本体。外部へ出る操作はすべてここを通る:
   * 宣言チェック → 承認ダイアログ(何を・どこへ・全文プレビュー) → 実行 → audit。
   * 承認されなければ executor には一切到達しない。
   */
  async requestExecute(
    adapterId: string,
    action: string,
    target: string,
    preview: string,
    params: Record<string, unknown>,
  ): Promise<IwatoExecuteResult> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return { ok: false, detail: `未登録のアダプタ: ${adapterId}` };
    if (!adapter.capabilities.execute.includes(action)) {
      // 宣言していないアクションは承認ダイアログにすら出さない(x等の「提案のみ」媒体)
      this.audit({
        kind: 'operations-execute',
        adapterId,
        action,
        target,
        approved: false,
        detail: 'capabilities.execute に無いアクション(拒否)',
      });
      return { ok: false, detail: `${adapterId} は '${action}' を実行できない(提案のみの媒体)` };
    }

    const request: IwatoRequestPayload = {
      id: randomUUID(),
      adapterId,
      action,
      target,
      preview,
      compliance: adapter.compliance,
    };
    const approved = await this.approvalPrompt(request);
    if (!approved) {
      this.audit({
        kind: 'operations-execute',
        adapterId,
        action,
        target,
        approved: false,
        detail: 'ユーザーが承認しなかった',
      });
      return { ok: false, detail: '承認されなかったため実行していない' };
    }

    const executor = sealedExecutors.get(this)?.get(adapterId);
    if (!executor) {
      return { ok: false, detail: `アダプタ ${adapterId} に executor が無い(内部不整合)` };
    }
    try {
      const detail = await executor(action, params);
      this.audit({ kind: 'operations-execute', adapterId, action, target, approved: true, detail });
      return { ok: true, detail };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.audit({
        kind: 'operations-execute',
        adapterId,
        action,
        target,
        approved: true,
        detail: `実行失敗: ${detail}`,
      });
      return { ok: false, detail: `実行失敗: ${detail}` };
    }
  }
}
