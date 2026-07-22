import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
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
  /**
   * M99-6: 一括公開。1件目の下見を開き、その後は「送るたびに次の下見が自動で開く」。
   * **承認は1件ずつ全文を読んでもらう**(まとめて承認は作らない — 岩戸の掟)。
   * 続くのはダイアログの連鎖であって、承認の省略ではない
   */
  openMany: (toolNames: string[]) => void;
  /** 一括公開の残り件数(0=単発)。進行表示と取りやめボタンに使う */
  queueLen: number;
  /**
   * M99-7: 今止まっているツールを飛ばして次へ(一括中のみ意味を持つ)。
   * 再検証が不合格だと出口が「もう一度(また落ちる)」か「取りやめ(残り全部が道連れ)」しか
   * 無かった(実機でユーザーが発見)。1件の不合格が残りを人質に取らないための脱出口
   */
  skip: () => void;
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
  // M99-6: 一括公開の残り。state だと .then 内のクロージャが古い値を掴む(=1件で止まる)ので ref
  const queueRef = useRef<string[]>([]);
  const [queueLen, setQueueLen] = useState(0);

  const refreshPublished = useCallback((): void => {
    void window.api
      .pluginsPublishedList()
      .then(setPublished)
      .catch(() => {
        /* 控えが読めなくてもボタンは出す(公開を止めない) */
      });
  }, []);

  useEffect(() => refreshPublished(), [refreshPublished]);

  /** 一括公開の次の1件へ。続きが無ければ false(単発時も false) */
  const advance = (): boolean => {
    const next = queueRef.current.shift();
    setQueueLen(queueRef.current.length);
    if (next === undefined) return false;
    open(next);
    return true;
  };

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
          advance(); // 一括中なら公開済みは飛ばして次へ
          return;
        }
        if (!r.ok || r.preview === undefined) {
          // M98: 証跡が無いだけなら再検証で公開可能になる。ユーザーに次の一手を示す
          // (unverified = M96より前に作られたツール。ここで諦めさせない)
          if (r.verification === 'unverified' || r.verification === 'stale') {
            setNeedsReverify(toolName);
          }
          // 一括中はここで**止まる**(飛ばさない)。再検証→公開が済めば advance で続きが動く。
          // 残り件数は進行表示に出ていて、「取りやめ」でいつでも中断できる
          setMessage(`✗ ${r.message}`);
          return;
        }
        setPlan({ toolName, preview: r.preview, leaks: r.leaks ?? [] });
        setMessage('');
      })
      .catch((err: unknown) => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  /** M99-6: 一括公開の入口。以前は先頭1件を開くだけで、公開後に続きが無かった(実機で発覚) */
  const openMany = (toolNames: string[]): void => {
    if (toolNames.length === 0) return;
    queueRef.current = toolNames.slice(1);
    setQueueLen(queueRef.current.length);
    open(toolNames[0]!);
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
          advance(); // 一括中は次の下見を開く(承認は次の全文で改めてもらう)
        }
      })
      .catch((err: unknown) => setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  const close = (): void => {
    const remaining = queueRef.current.length;
    queueRef.current = [];
    setQueueLen(0);
    setPlan(null);
    setNeedsReverify(null);
    setMessage(
      remaining > 0
        ? `一括公開を取りやめました(残り${remaining}件は未公開のまま。あとで「まとめて公開」からやり直せます)`
        : '公開を取りやめました(あとでツール一覧からいつでも公開できます)',
    );
  };

  /** M99-7: 止まっている1件(下見中・再検証待ち・不合格のいずれでも)を諦めて次へ */
  const skip = (): void => {
    setPlan(null);
    setNeedsReverify(null);
    if (!advance()) {
      setMessage('飛ばした(一括公開はこれで終わり。飛ばした分はあとでツール一覧から個別に公開できます)');
    }
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

  return { plan, message, busy, published, open, openMany, queueLen, skip, close, submit, needsReverify, reverify };
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
