import { useCallback, useEffect, useState, type JSX } from 'react';
import type { PublishedPluginInfo } from '../../../../shared/types';

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
  /** 改善1: 公開済みツール(名前→PR URL/時刻)。ボタンを止め、「公開済み」を出すのに使う */
  published: Record<string, PublishedPluginInfo>;
  open: (toolName: string) => void;
  close: () => void;
  submit: (draft: boolean) => void;
  /** M98: 証跡が無くて公開できなかったツール名(再検証を促す) */
  needsReverify: string | null;
  /** M98: 再検証(本物の4ゲートを回して証跡を作る)。成功すればそのまま公開下見へ進む */
  reverify: (toolName: string) => void;
} {
  const [plan, setPlan] = useState<PublishState | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<Record<string, PublishedPluginInfo>>({});
  const [needsReverify, setNeedsReverify] = useState<string | null>(null);

  const refreshPublished = useCallback((): void => {
    void window.api
      .pluginsPublishedList()
      .then(setPublished)
      .catch(() => {
        /* 控えが読めなくてもボタンは出す(公開を止めない) */
      });
  }, []);

  useEffect(() => refreshPublished(), [refreshPublished]);

  const open = (toolName: string): void => {
    setMessage(`… ${toolName} の公開内容を用意しています`);
    setBusy(true);
    void window.api
      .pluginsUploadPlan(toolName)
      .then((r) => {
        // 既に公開済みなら下見は返らない。控えを取り直してボタンを止める
        if (r.published === true) {
          setMessage(`✓ ${r.message}`);
          refreshPublished();
          return;
        }
        if (!r.ok || r.preview === undefined) {
          // M98: 証跡が無いだけなら再検証で公開可能になる。ユーザーに次の一手を示す
          // (unverified = M96より前に作られたツール。ここで諦めさせない)
          if (r.verification === 'unverified' || r.verification === 'stale') {
            setNeedsReverify(toolName);
          }
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
        if (r.ok) {
          setPlan(null);
          refreshPublished(); // 出せた瞬間に控えを反映=以後この機体では公開ボタンが消える
        }
      })
      .catch((err: unknown) => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  const close = (): void => {
    setPlan(null);
    setMessage('公開を取りやめました(あとでツール一覧からいつでも公開できます)');
  };

  /**
   * M98: 既存ツールの再検証。証跡が無い(M96より前に作られた)ツールを、今から
   * 本物の4ゲート(検査→型検査→テスト→スモーク)に通して証跡を作る。
   * 合格したらそのまま公開の下見へ進む(「再検証→公開」を1クリックの流れにする)
   */
  const reverify = (toolName: string): void => {
    setBusy(true);
    setMessage(`… ${toolName} を検証し直しています(型検査・テスト・スモーク)`);
    void window.api
      .pluginsReverify(toolName)
      .then((r) => {
        setMessage(`${r.ok ? '✓' : '✗'} ${r.message}`);
        if (r.ok) {
          setNeedsReverify(null);
          open(toolName); // 証跡ができた=そのまま公開の下見へ
        }
      })
      .catch((err: unknown) => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  return { plan, message, busy, published, open, close, submit, needsReverify, reverify };
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
