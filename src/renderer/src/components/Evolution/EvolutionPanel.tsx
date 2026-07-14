import { useEffect, useState } from 'react';
import type { EvolutionJobStatus, EvolutionScope, ProvisionalInstall } from '../../../../shared/types';
import { useEvolutionStore } from '../../stores/evolution';
import { PublishPluginDialog, usePublishPlugin } from '../Registry/PublishPlugin';

const STATUS_LABEL: Record<EvolutionJobStatus, { text: string; cls: string }> = {
  queued: { text: '待機中', cls: 'text-zinc-400' },
  preparing_worktree: { text: 'B環境準備中', cls: 'text-blue-300' },
  generating: { text: '生成中', cls: 'text-blue-300' },
  verifying: { text: '検証中', cls: 'text-amber-300' },
  awaiting_promotion: { text: '昇格承認待ち', cls: 'text-amber-300' },
  promoting: { text: '昇格中', cls: 'text-blue-300' },
  done: { text: '完了', cls: 'text-green-400' },
  failed: { text: '失敗', cls: 'text-red-400' },
  rejected: { text: '却下', cls: 'text-zinc-400' },
  cancelled: { text: 'キャンセル済み', cls: 'text-zinc-400' },
  rolled_back: { text: 'ロールバック済み', cls: 'text-red-400' },
};

/** M26-6: キャンセル可能な状態(昇格待ち以降は昇格ダイアログの「却下」が担当) */
const CANCELLABLE: EvolutionJobStatus[] = ['queued', 'preparing_worktree', 'generating', 'verifying'];

/**
 * 昇格履歴エントリの「どういう能力か」要約を導出する。
 * kind=tool は現在ロード中のツール説明(toolsList)から引く(複数ツールなら「name: 説明」を連結)。
 * それ以外(renderer/core)は M25-3: マージコミット本文に埋め込まれたジョブの説明(body)を使う。
 * body が無い(旧evolveタグ・説明未記録)場合のみ subject にフォールバックする。
 * (git タグからの導出ロジックは src/main/evolution=聖域のため renderer 側で補完する)
 */
export function capabilitySummary(
  h: { kind: 'tool' | 'renderer' | 'core'; toolNames: string[]; subject: string; body?: string },
  toolDescs: Record<string, string>,
): string {
  if (h.kind === 'tool' && h.toolNames.length > 0) {
    const parts = h.toolNames
      .map((n) => {
        const d = toolDescs[n];
        if (d === undefined || d === '') return '';
        return h.toolNames.length > 1 ? `${n}: ${d}` : d;
      })
      .filter((s) => s !== '');
    if (parts.length > 0) return parts.join(' / ');
  }
  if (h.body !== undefined && h.body.trim() !== '') return h.body.trim();
  return h.subject;
}

/** M20: スコープバッジ(tool=灰 / renderer=青 / core=赤) */
function ScopeBadge({ scope }: { scope?: EvolutionScope }): JSX.Element {
  const s = scope ?? 'tool';
  const cls =
    s === 'core'
      ? 'bg-red-900/70 text-red-300'
      : s === 'renderer'
        ? 'bg-blue-900/70 text-blue-300'
        : 'bg-zinc-800 text-zinc-400';
  return <span className={`rounded px-1 text-[10px] ${cls}`}>{s}</span>;
}

export function EvolutionPanel(): JSX.Element {
  const { jobs, loadJobs } = useEvolutionStore();
  const [desc, setDesc] = useState('');
  const [io, setIo] = useState('');
  const [scope, setScope] = useState<EvolutionScope>('tool');
  const [openLog, setOpenLog] = useState<number | null>(null);
  // M20→M23-6: 昇格履歴を「獲得した能力」(kind/ツール名/変更ファイル)付きで表示
  const [history, setHistory] = useState<
    {
      tag: string;
      commit: string;
      date: string;
      subject: string;
      body: string;
      kind: 'tool' | 'renderer' | 'core';
      toolNames: string[];
      files: string[];
    }[]
  >([]);
  // ツール名→説明。kind=tool の履歴に「どういう能力か」の要約を出すために使う
  const [toolDescs, setToolDescs] = useState<Record<string, string>>({});
  const [rollbackMsg, setRollbackMsg] = useState('');
  // M27-4: プラグインインポートの結果表示
  const [importMsg, setImportMsg] = useState('');
  const [importing, setImporting] = useState(false);
  // M28-2: 配布版では進化機能が無効(理由バナーを出し、起動系ボタンを無効化)
  const [packaged, setPackaged] = useState(false);
  // M29-5: 仮導入(棚卸し待ち)。未応答のものは次回起動時もここに再提示される
  const [provisional, setProvisional] = useState<ProvisionalInstall[]>([]);
  const [inventoryMsg, setInventoryMsg] = useState('');
  // M91-2: 導入したツールをレジストリへ公開する(下見→全文承認→PR)
  const publish = usePublishPlugin();

  const loadInventory = async (): Promise<void> => {
    try {
      setProvisional(await window.api.inventoryList());
    } catch {
      /* 表示のみの情報 */
    }
  };

  const resolveInventory = (jobId: number, keep: boolean): void => {
    void window.api
      .inventoryResolve(jobId, keep)
      .then((r) => {
        setInventoryMsg(`${r.ok ? '✓' : '✗'} ${r.message}`);
        void loadInventory();
      })
      .catch((err: unknown) => setInventoryMsg(`✗ ${err instanceof Error ? err.message : String(err)}`));
  };

  const loadHistory = async (): Promise<void> => {
    try {
      setHistory(await window.api.evolutionCapabilities());
      const { tools } = await window.api.toolsList();
      setToolDescs(Object.fromEntries(tools.map((t) => [t.name, t.description])));
    } catch {
      /* 履歴は表示のみの情報 */
    }
  };

  useEffect(() => {
    void loadJobs();
    void loadHistory();
    void loadInventory();
    void window.api
      .runtimeFlags()
      .then((f) => setPackaged(f.packaged === true))
      .catch(() => {});
  }, [loadJobs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 border-t border-zinc-700 bg-zinc-950 p-3 text-sm">
      {/* M91: 配布版でも「ツール」は作れる(プラグイン単位で本物の検証を回す)。
          作れないのは本体(core/renderer)だけ — それは全員が同じコアを使うための設計 */}
      {packaged && (
        <div className="rounded border border-sky-800 bg-sky-950/60 p-2 text-xs text-sky-200">
          ℹ 配布版では <b>ツール(プラグイン)の生成・導入</b> ができます(型検査・テスト実行・
          スモークを実際に回してから、全文確認と承認を経て導入)。
          <b>本体(core/renderer)の書き換えは開発版のみ</b>です — 全員が同じコア/UIを使う設計のため。
          本体への要望は「要望を送る」からIssueとして提出できます
        </div>
      )}
      {/* M29-3: 狭幅では折り返す(flex-wrap)。ボタン文字の縦書き化・横スクロールを防ぐ */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-zinc-400">進化ジョブ</span>
        <input
          className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
          placeholder="必要な能力/変更の説明(手動起動・デバッグ用)"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <input
          className="min-w-[8rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
          placeholder="期待する入出力/挙動"
          value={io}
          onChange={(e) => setIo(e.target.value)}
        />
        <select
          className="shrink-0 rounded border border-zinc-600 bg-zinc-800 px-1 py-1 text-xs"
          value={scope}
          title="進化スコープ(renderer/coreは常に人間承認+再起動)"
          onChange={(e) => setScope(e.target.value as EvolutionScope)}
        >
          <option value="tool">tool</option>
          {/* M91: 配布版で本体スコープは選べない(コアは全員同じ。要望としてIssueへ) */}
          <option value="renderer" disabled={packaged}>
            renderer
          </option>
          <option value="core" disabled={packaged}>
            core
          </option>
        </select>
        <button
          className="shrink-0 whitespace-nowrap rounded bg-purple-700 px-3 py-1 text-xs hover:bg-purple-600 disabled:opacity-40"
          disabled={!desc.trim() || (packaged && scope !== 'tool')}
          title={packaged && scope !== 'tool' ? '配布版では本体(core/renderer)の書き換えはできません' : ''}
          onClick={() => {
            void window.api.evolutionEnqueue(desc, io || '(指定なし)', scope);
            setDesc('');
            setIo('');
          }}
        >
          ジョブ起動
        </button>
        {/* M27-4: 共有プラグインのインポート(検査→検証ゲート→承認→導入) */}
        <button
          className="shrink-0 whitespace-nowrap rounded bg-emerald-800 px-3 py-1 text-xs hover:bg-emerald-700 disabled:opacity-40"
          disabled={importing}
          title="コミュニティ/エクスポート済みプラグインのフォルダを選んで導入する(検査と承認を必ず通る)"
          onClick={() => {
            setImporting(true);
            setImportMsg('');
            void window.api
              .pluginsImport()
              .then((r) => {
                const warn = r.warnings !== undefined && r.warnings.length > 0 ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : '';
                setImportMsg(`${r.ok ? '✓' : '✗'} ${r.message}${warn}`);
              })
              .catch((err: unknown) => setImportMsg(`✗ ${err instanceof Error ? err.message : String(err)}`))
              .finally(() => setImporting(false));
          }}
        >
          📦 インポート
        </button>
      </div>
      {importMsg !== '' && (
        <p className="whitespace-pre-wrap text-xs text-zinc-300">{importMsg}</p>
      )}
      {jobs.length === 0 && <p className="text-xs text-zinc-500">ジョブはまだない</p>}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {jobs.map((j) => (
          <div key={j.id} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-zinc-400">#{j.id}</span>
              <ScopeBadge {...(j.scope !== undefined ? { scope: j.scope } : {})} />
              {/* M29-3: truncate は min-w-0 な flex 子でないと縮まない(横はみ出しの原因) */}
              <span className="min-w-0 flex-1 truncate">{j.description}</span>
              {j.toolName && <span className="shrink-0 font-mono text-blue-300">{j.toolName}</span>}
              {/* M20: 聖域トリップワイヤによる拒否は明示的に表示 */}
              {j.protectedReject === true && (
                <span className="shrink-0 whitespace-nowrap rounded bg-red-900/70 px-1 text-[10px] text-red-300">🛡 保護領域のため拒否</span>
              )}
              <span className={`shrink-0 whitespace-nowrap ${STATUS_LABEL[j.status].cls}`}>{STATUS_LABEL[j.status].text}</span>
              {/* M26-6: 実行中/待機中ジョブのキャンセル */}
              {CANCELLABLE.includes(j.status) && (
                <button
                  className="shrink-0 whitespace-nowrap rounded border border-red-800 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-950"
                  title="このジョブをキャンセルする(待機中=キューから除去/実行中=中断)"
                  onClick={() => void window.api.evolutionCancel(j.id)}
                >
                  ✕ キャンセル
                </button>
              )}
              {/* M91-2: 検証を通って導入された直後が、公開するか決める自然な瞬間。
                  ここで断っても、ツール一覧の「⛩ 公開」から後でいつでも出せる */}
              {j.status === 'done' && j.scope !== 'renderer' && j.scope !== 'core' && j.toolName !== undefined && (
                <button
                  className="shrink-0 whitespace-nowrap rounded border border-amber-800 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-950"
                  title="このツールをレジストリへ公開する(送信前に全文を確認・承認します)"
                  onClick={() => publish.open(j.toolName!)}
                >
                  ⛩ 公開しますか？
                </button>
              )}
              <button
                className="text-zinc-500 hover:text-zinc-300"
                onClick={() => setOpenLog(openLog === j.id ? null : j.id)}
              >
                {openLog === j.id ? '▲' : '▼'}
              </button>
            </div>
            {openLog === j.id && (
              <div className="mt-1 space-y-1 border-t border-zinc-700 pt-1 text-zinc-400">
                {j.error && <p className="text-red-400">エラー: {j.error}</p>}
                {j.gates.map((g) => (
                  <p key={g.name}>
                    {g.ok ? '✓' : '✗'} {g.name}: {g.detail.slice(0, 300)}
                  </p>
                ))}
                {j.log.map((l, i) => (
                  <p key={i} className="font-mono">{l}</p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {publish.message !== '' && <p className="text-xs text-zinc-400">{publish.message}</p>}
      {publish.plan !== null && (
        <PublishPluginDialog
          plan={publish.plan}
          busy={publish.busy}
          onSubmit={publish.submit}
          onCancel={publish.close}
        />
      )}

      {/* M29-5: 仮導入の棚卸し(未応答分。自律実行終了時のカードと同じ操作) */}
      {provisional.length > 0 && (
        <div className="space-y-1 rounded border border-emerald-800 bg-emerald-950/30 p-2">
          <p className="text-xs font-semibold text-emerald-300">📦 仮導入の棚卸し({provisional.length}件)</p>
          {provisional.map((p) => (
            <div key={p.jobId} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-emerald-300">{p.toolName}</span>
              <span className="shrink-0 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
                {p.origin === 'registry' ? 'コミュニティ' : '自己生成'}
              </span>
              <span className="ml-auto flex shrink-0 gap-1.5">
                <button
                  className="whitespace-nowrap rounded bg-emerald-700 px-2 py-0.5 text-[11px] hover:bg-emerald-600"
                  onClick={() => resolveInventory(p.jobId, true)}
                >
                  残す
                </button>
                <button
                  className="whitespace-nowrap rounded border border-red-800 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-950"
                  title="完全アンインストール(昇格をrevertする)"
                  onClick={() => resolveInventory(p.jobId, false)}
                >
                  削除
                </button>
              </span>
            </div>
          ))}
          {inventoryMsg !== '' && <p className="text-[11px] text-zinc-400">{inventoryMsg}</p>}
        </div>
      )}

      {/* M20: ロールバック履歴(evolveタグ)と「1つ前へ戻す」— 右ペインの残り高さを使う */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-zinc-800 pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="whitespace-nowrap text-xs font-semibold text-zinc-400">獲得した能力(昇格履歴)</span>
          <button
            className="shrink-0 whitespace-nowrap rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
            onClick={() => void loadHistory()}
          >
            更新
          </button>
          <button
            className="shrink-0 whitespace-nowrap rounded border border-red-800 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-950 disabled:opacity-40"
            disabled={history.length === 0}
            title="HEADが最新evolveマージのときのみrevertする(履歴は残る)"
            onClick={() => {
              void window.api.evolutionRollbackLast().then((r) => {
                setRollbackMsg(r.message);
                void loadHistory();
              });
            }}
          >
            ⏪ 1つ前へ戻す
          </button>
        </div>
        {rollbackMsg && <p className="mt-1 text-[11px] text-amber-300">{rollbackMsg}</p>}
        {history.length === 0 ? (
          <p className="mt-1 text-[11px] text-zinc-500">昇格履歴なし(進化で獲得した能力がここに並ぶ)</p>
        ) : (
          <ul className="mt-1 max-h-[60vh] min-h-0 flex-1 space-y-1 overflow-y-auto text-[11px] text-zinc-400">
            {history.map((h) => {
              const summary = capabilitySummary(h, toolDescs);
              return (
                <li key={h.tag} className="rounded border border-zinc-800 px-2 py-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="shrink-0 font-mono text-purple-300">{h.tag}</span>
                    {/* M23-6: 獲得の種類(ツール追加 or 自己書き換え) */}
                    <span
                      className={`shrink-0 whitespace-nowrap rounded px-1 text-[10px] ${
                        h.kind === 'tool'
                          ? 'bg-zinc-800 text-zinc-300'
                          : h.kind === 'renderer'
                            ? 'bg-blue-900/70 text-blue-300'
                            : 'bg-red-900/70 text-red-300'
                      }`}
                    >
                      {h.kind === 'tool' ? '🔧 ツール追加' : h.kind === 'renderer' ? '🎨 UI自己書き換え' : '⚙ コア自己書き換え'}
                    </span>
                    {h.toolNames.map((n) => (
                      <span key={n} className="rounded bg-emerald-900/50 px-1 font-mono text-[10px] text-emerald-300">
                        {n}
                      </span>
                    ))}
                    <span className="ml-auto shrink-0 text-zinc-500">{h.date.slice(0, 16)}</span>
                  </div>
                  {/* どういう能力かの要約(空なら非表示・長文は3行で省略) */}
                  {summary !== '' && (
                    <p className="mt-0.5 line-clamp-3 text-[11px] text-zinc-400">{summary}</p>
                  )}
                  <details className="mt-0.5">
                    <summary className="cursor-pointer text-zinc-500">
                      変更ファイル {h.files.length}件 — {h.subject}
                    </summary>
                    <ul className="mt-0.5 space-y-0.5 pl-3 font-mono text-[10px] text-zinc-500">
                      {h.files.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function PromotionDialog(): JSX.Element | null {
  const { promotion, respondPromotion } = useEvolutionStore();
  const [confirmed, setConfirmed] = useState(false);
  if (!promotion) return null;
  // M20: renderer/core は本体変更 — 二段確認(チェック+ボタン)を必須にする
  const isCoreChange = promotion.scope === 'renderer' || promotion.scope === 'core';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className={`w-[720px] max-w-[95vw] rounded-lg border ${
          isCoreChange ? 'border-red-700' : 'border-purple-700'
        } bg-zinc-900 p-4 shadow-xl`}
      >
        {isCoreChange && (
          <div className="mb-2 rounded-md border border-red-700 bg-red-950 p-2 text-xs font-semibold text-red-300">
            ⚠ これは本体のコア変更です(scope: {promotion.scope})。
            {promotion.requiresRestart === true && ' 承認すると再ビルド+健全性チェック後にアプリが再起動します。'}
            失敗時は自動でrevertされ、再起動後の連続クラッシュはセーフモードで保護されます。
          </div>
        )}
        <h2 className="mb-2 text-sm font-semibold">
          進化ジョブ #{promotion.jobId} の昇格承認:{' '}
          <code className="text-purple-300">{promotion.toolName}</code>
          {promotion.scope !== undefined && (
            <span className="ml-2 rounded bg-zinc-800 px-1.5 text-xs text-zinc-300">scope: {promotion.scope}</span>
          )}
        </h2>
        <p className="mb-2 text-xs text-zinc-400">
          検証ゲート(聖域トリップワイヤ / 危険検出 / 差分検査 / typecheck / vitest / build / スモーク)は全合格。
          mainブランチへマージして{isCoreChange ? '再ビルド・再起動で反映する' : '稼働中のアプリに動的ロードする'}。
        </p>
        {promotion.warnings.length > 0 && (
          <div className="mb-2 rounded-md border border-red-700 bg-red-950 p-2 text-xs text-red-300">
            {promotion.warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}
        <pre className="mb-3 max-h-72 overflow-auto rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs leading-5 text-zinc-300">
          {promotion.diff}
        </pre>
        {isCoreChange && (
          <label className="mb-3 flex items-center gap-2 text-xs text-zinc-200">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            diff全文を確認し、本体コードの変更であることを理解した
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button
            className="rounded-md border border-zinc-600 px-4 py-1.5 text-sm hover:bg-zinc-800"
            onClick={() => {
              setConfirmed(false);
              respondPromotion(false);
            }}
          >
            却下
          </button>
          <button
            className={`rounded-md px-4 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
              isCoreChange ? 'bg-red-700 hover:bg-red-600' : 'bg-purple-700 hover:bg-purple-600'
            }`}
            disabled={isCoreChange && !confirmed}
            onClick={() => {
              setConfirmed(false);
              respondPromotion(true);
            }}
          >
            {isCoreChange ? '本体変更を承認(自己責任)' : '昇格を承認'}
          </button>
        </div>
      </div>
    </div>
  );
}
