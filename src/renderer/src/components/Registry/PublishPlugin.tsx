import { useState, type JSX } from 'react';

/**
 * M91-2: 作ったツールをレジストリへ出す口。**下見 → 全文承認 → 送信**の3段を1か所にまとめる。
 * ここを共通にしているのは、ツール一覧からでも、進化ジョブの完了直後からでも、
 * 「出す/出さない」の判断材料(=これから送る全文)が同じでなければならないため。
 * その場で断っても、あとからツール一覧の「⛩ 公開」で同じ手順を踏める
 */

export interface PublishState {
  toolName: string;
  preview: string;
  leaks: string[];
}

export function usePublishPlugin(): {
  plan: PublishState | null;
  message: string;
  busy: boolean;
  open: (toolName: string) => void;
  close: () => void;
  submit: (draft: boolean) => void;
} {
  const [plan, setPlan] = useState<PublishState | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const open = (toolName: string): void => {
    setMessage(`… ${toolName} の公開内容を用意しています`);
    setBusy(true);
    void window.api
      .pluginsUploadPlan(toolName)
      .then((r) => {
        if (!r.ok || r.preview === undefined) {
          setMessage(`✗ ${r.message}`);
          return;
        }
        setPlan({ toolName, preview: r.preview, leaks: r.leaks ?? [] });
        setMessage('');
      })
      .catch((err: unknown) => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  const submit = (draft: boolean): void => {
    if (plan === null) return;
    setBusy(true);
    setMessage('… 送信中(fork → ブランチ → PR)');
    void window.api
      .pluginsUpload(plan.toolName, plan.preview, draft)
      .then((r) => {
        setMessage(`${r.ok ? '✓' : '✗'} ${r.message}`);
        if (r.ok) setPlan(null);
      })
      .catch((err: unknown) => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  const close = (): void => {
    setPlan(null);
    setMessage('公開を取りやめました(あとでツール一覧からいつでも公開できます)');
  };

  return { plan, message, busy, open, close, submit };
}

export function PublishPluginDialog({
  plan,
  busy,
  onSubmit,
  onCancel,
}: {
  plan: PublishState;
  busy: boolean;
  onSubmit: (draft: boolean) => void;
  onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(false);
  return (
    <div className="mt-2 rounded border border-amber-800 bg-amber-950/40 p-2">
      <p className="text-[11px] font-semibold text-amber-200">
        ⛩ 公開の確認 — これから外部(GitHub)へ送ります。全文を読んでから承認してください
      </p>
      {plan.leaks.length > 0 && (
        <p className="mt-1 whitespace-pre-wrap text-[11px] text-red-300">
          {`⚠ 機械チェックの検出(このままでは送信できません):\n${plan.leaks.join('\n')}`}
        </p>
      )}
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-[10px] text-zinc-300">
        {plan.preview}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-zinc-400">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          下書きPRとして出す(レビュー要求を出さない)
        </label>
        <button
          className="rounded bg-amber-700 px-3 py-1 text-[11px] hover:bg-amber-600 disabled:opacity-40"
          disabled={busy || plan.leaks.length > 0}
          onClick={() => onSubmit(draft)}
        >
          承認して公開する
        </button>
        <button
          className="rounded border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={onCancel}
        >
          やめる
        </button>
      </div>
    </div>
  );
}
