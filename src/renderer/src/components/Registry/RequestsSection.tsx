import { useEffect, useState, type JSX } from 'react';
import type { CoreRequest, CoreRequestKind } from '../../../../shared/types';
import { useT } from '../../i18n';

/**
 * M91-3: 本体(コア/UI)への要望。
 *
 * ツールは自分の機体で作れる(配布版でも)。だがコア/UIは作れない — 全員が同じコアを使うのが
 * この設計の前提だから。行き止まりに当たったときに、その事実を上流へ運ぶのがここ。
 * 下書きの出どころは2つ(人が書く/AMA-teras が書く)。どちらも**同じ門**を通る:
 * 全文を人間が読み、承認したときだけ先へ進む。
 *
 * M99-5: 宛先は機体で変わる。配布版=上流(開発リポジトリ)へのIssue。
 * 開発機=この機体が上流なので、Issueを経由せずそのまま進化ジョブとして起票する
 * (「本体から本体に要望を送る」一周無駄をなくす。ユーザー指摘)
 */
export function RequestsSection(): JSX.Element {
  const t = useT();
  const [items, setItems] = useState<CoreRequest[]>([]);
  const [kind, setKind] = useState<CoreRequestKind>('ui');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // packaged が判るまでボタンを出さない(誤った宛先の一瞬表示を防ぐ)
  const [packaged, setPackaged] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<{
    id: string;
    mode: 'issue' | 'job';
    preview: string;
    leaks: string[];
    similar: { title: string; url: string; number: number }[];
  } | null>(null);

  const load = (): void => {
    void window.api
      .requestsList()
      .then(setItems)
      .catch(() => {});
  };

  useEffect(() => {
    load();
    void window.api
      .runtimeFlags()
      .then((f) => setPackaged(f.packaged === true))
      .catch(() => setPackaged(true)); // 判らなければ配布版扱い(Issue経路=安全側)
    // AMA-teras 側が作業中に起票することがあるので、開いている間は拾い直す
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const drafts = items.filter((r) => r.status === 'draft');
  const sent = items.filter((r) => r.status === 'sent' || r.status === 'filed');

  const openPlan = (id: string): void => {
    setBusy(true);
    setMsg(t('req.preparing'));
    void window.api
      .requestsPlan(id)
      .then((r) => {
        if (!r.ok || r.preview === undefined) {
          setMsg(`✗ ${r.message}`);
          return;
        }
        setPlan({ id, mode: 'issue', preview: r.preview, leaks: r.leaks ?? [], similar: r.similar ?? [] });
        setMsg('');
      })
      .catch((err: unknown) => setMsg(`✗ ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  /** M99-5: 開発機の下見。外部送信ではないので機械チェック・重複検索は不要=全文確認だけが門 */
  const openJobPlan = (r: CoreRequest): void => {
    const scope = r.kind === 'ui' ? t('req.scopeUi') : t('req.scopeCore');
    setPlan({
      id: r.id,
      mode: 'job',
      preview: `[要望] ${r.title}\n\nスコープ: ${scope}\n出どころ: ${r.source === 'agent' ? 'AMA-teras' : t('req.byHuman')}\n\n${r.body}`,
      leaks: [],
      similar: [],
    });
    setMsg('');
  };

  return (
    <div className="space-y-1 rounded border border-zinc-700 bg-zinc-900/60 p-2">
      <p className="text-xs font-semibold text-zinc-300">{t('req.heading')}</p>
      <p className="text-[11px] text-zinc-500">
        {packaged === false ? t('req.descDev') : t('req.descPackaged')}
      </p>

      <div className="flex flex-wrap items-center gap-1">
        <select
          className="rounded border border-zinc-600 bg-zinc-800 px-1 py-1 text-xs"
          value={kind}
          onChange={(e) => setKind(e.target.value as CoreRequestKind)}
        >
          <option value="ui">{t('req.kindUi')}</option>
          <option value="core">{t('req.kindCore')}</option>
        </select>
        <input
          className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
          placeholder={t('req.titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <textarea
        className="h-16 w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
        placeholder={t('req.bodyPlaceholder')}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <button
        className="rounded bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600 disabled:opacity-40"
        disabled={busy || title.trim() === '' || body.trim() === ''}
        onClick={() => {
          setBusy(true);
          void window.api
            .requestsCreate(kind, title, body)
            .then(() => {
              setTitle('');
              setBody('');
              setMsg(t('req.drafted'));
              load();
            })
            .catch((err: unknown) => setMsg(`✗ ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => setBusy(false));
        }}
      >
        {t('req.draftIt')}
      </button>

      {msg !== '' && <p className="text-[11px] text-zinc-400">{msg}</p>}

      {drafts.length > 0 && (
        <ul className="space-y-1">
          {drafts.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-xs">
              <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{r.kind}</span>
              <span
                className={`rounded px-1 text-[10px] ${
                  r.source === 'agent' ? 'bg-purple-900/70 text-purple-300' : 'bg-zinc-800 text-zinc-400'
                }`}
                title={r.source === 'agent' ? t('req.byAgentTitle') : t('req.byHumanTitle')}
              >
                {r.source === 'agent' ? 'AMA-teras' : t('req.byHuman')}
              </span>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              {packaged !== null && (
                <button
                  className="shrink-0 rounded border border-amber-800 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-950"
                  onClick={() => (packaged ? openPlan(r.id) : openJobPlan(r))}
                >
                  {packaged ? t('req.reviewSend') : t('req.reviewFile')}
                </button>
              )}
              <button
                className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
                onClick={() => {
                  void window.api.requestsDiscard(r.id).then(() => {
                    if (plan?.id === r.id) setPlan(null);
                    load();
                  });
                }}
              >
                {t('req.discard')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {plan !== null && (
        <div className="rounded border border-amber-800 bg-amber-950/40 p-2">
          <p className="text-[11px] font-semibold text-amber-200">
            {plan.mode === 'job'
              ? t('req.confirmJob')
              : t('req.confirmIssue')}
          </p>
          {plan.mode === 'job' && (
            <p className="mt-1 text-[11px] text-amber-200/80">
              {t('req.sanctuaryNote')}
            </p>
          )}
          {plan.similar.length > 0 && (
            <div className="mt-1 text-[11px] text-amber-200">
              {t('req.similar')}
              <ul className="ml-3 list-disc">
                {plan.similar.slice(0, 5).map((s) => (
                  <li key={s.number}>
                    #{s.number} {s.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.leaks.length > 0 && (
            <p className="mt-1 whitespace-pre-wrap text-[11px] text-red-300">
              {`${t('req.leaks')}\n${plan.leaks.join('\n')}`}
            </p>
          )}
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-[10px] text-zinc-300">
            {plan.preview}
          </pre>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-amber-700 px-3 py-1 text-[11px] hover:bg-amber-600 disabled:opacity-40"
              disabled={busy || plan.leaks.length > 0}
              onClick={() => {
                setBusy(true);
                setMsg(plan.mode === 'job' ? t('req.filing') : t('req.sending'));
                const action =
                  plan.mode === 'job'
                    ? window.api.requestsFileJob(plan.id)
                    : window.api.requestsSubmit(plan.id, plan.preview);
                void action
                  .then((r) => {
                    setMsg(`${r.ok ? '✓' : '✗'} ${r.message}`);
                    if (r.ok) setPlan(null);
                    load();
                  })
                  .catch((err: unknown) => setMsg(`✗ ${err instanceof Error ? err.message : String(err)}`))
                  .finally(() => setBusy(false));
              }}
            >
              {plan.mode === 'job' ? t('req.approveFile') : t('req.approveSend')}
            </button>
            <button
              className="rounded border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
              onClick={() => {
                setPlan(null);
                setMsg(t('req.cancelled'));
              }}
            >
              {t('req.cancel')}
            </button>
          </div>
        </div>
      )}

      {sent.length > 0 && (
        <div className="space-y-1 border-t border-zinc-800 pt-1">
          <p className="text-[11px] font-semibold text-zinc-400">{t('req.sentHeading', { n: sent.length })}</p>
          <ul className="space-y-1">
            {[...sent]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-xs"
                >
                  <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{r.kind}</span>
                  <span
                    className={`rounded px-1 text-[10px] ${
                      r.source === 'agent' ? 'bg-purple-900/70 text-purple-300' : 'bg-zinc-800 text-zinc-400'
                    }`}
                    title={r.source === 'agent' ? t('req.byAgentTitle') : t('req.byHumanTitle')}
                  >
                    {r.source === 'agent' ? 'AMA-teras' : t('req.byHuman')}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={r.title}>
                    {r.title}
                  </span>
                  {r.status === 'filed' ? (
                    <span className="shrink-0 rounded border border-purple-800 px-1.5 py-0.5 text-[10px] text-purple-300">
                      {t('req.job', { id: r.jobId ?? '?' })}
                    </span>
                  ) : r.url !== undefined ? (
                    <a
                      className="shrink-0 rounded border border-green-800 px-1.5 py-0.5 text-[10px] text-green-300 hover:bg-green-950"
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      title={r.url}
                    >
                      {t('req.openIssue')}
                    </a>
                  ) : (
                    <span className="shrink-0 text-[10px] text-zinc-600">{t('req.noUrl')}</span>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
