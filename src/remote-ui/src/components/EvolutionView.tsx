import { useEffect, useRef, useState } from 'react';
import { isPublishableJob } from '../../../shared/evolutionStatus';
import type { RemoteApi } from '../api';
import { useRemoteStore } from '../store';

/**
 * M99: スマホからも「作る→検証→公開」を最後まで通せるようにする。
 * これまでは投入とジョブ一覧だけで、公開(⛩)も再検証も獲得能力もデスクトップ専用だった。
 *
 * 掟は据え置き: 送信前に**全文**を画面に出し、それを承認したときだけ送る
 * (下見で見せた全文をそのまま送り返し、main側でも突き合わせる)。
 */

const DONE = ['done', 'failed', 'rejected', 'cancelled', 'rolled_back'];

interface UploadPlan {
  toolName: string;
  preview: string;
  leaks: string[];
}

export function EvolutionView({ api }: { api: RemoteApi }): JSX.Element {
  const { jobs, promotions, setTab } = useRemoteStore();
  const [description, setDescription] = useState('');
  const [expectedIO, setExpectedIO] = useState('');
  const [notice, setNotice] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [showCaps, setShowCaps] = useState(false);
  const [caps, setCaps] = useState<
    { tag: string; date: string; kind: string; toolNames: string[]; subject: string; body: string }[]
  >([]);
  const [published, setPublished] = useState<Record<string, { url: string; ts: string }>>({});
  const [plan, setPlan] = useState<UploadPlan | null>(null);
  const [needsReverify, setNeedsReverify] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);

  /**
   * 公開ボタンは畳んだ完了ジョブの中=画面のずっと下にあるのに、結果(下見・再検証・通知)は
   * 画面最上部に出る。スマホだと画面外なので「押しても無反応」に見えていた。返事の方を見せに行く。
   */
  useEffect(() => {
    if (plan !== null || needsReverify !== null || notice !== '') {
      feedbackRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [plan, needsReverify, notice]);

  const loadPublished = (): void => {
    void api
      .pluginsPublishedList()
      .then(setPublished)
      .catch(() => {
        /* 控えが読めなくても公開ボタンは出す */
      });
  };
  useEffect(loadPublished, [api]);

  const enqueue = async (): Promise<void> => {
    if (!description.trim()) return;
    setNotice('');
    try {
      const { jobId } = await api.evolutionEnqueue(description.trim(), expectedIO.trim());
      setNotice(`ジョブ #${jobId} を投入した`);
      setDescription('');
      setExpectedIO('');
    } catch (err) {
      setNotice(`投入失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const openPlan = async (toolName: string): Promise<void> => {
    setBusy(true);
    setNotice(`… ${toolName} の公開内容を用意しています`);
    setNeedsReverify(null);
    try {
      const r = await api.pluginsUploadPlan(toolName);
      if (r.published === true) {
        setNotice(`✓ ${r.message}`);
        loadPublished();
        return;
      }
      if (!r.ok || r.preview === undefined) {
        // 証跡が無いだけなら再検証で公開可能になる(ここで諦めさせない)
        if (r.verification === 'unverified' || r.verification === 'stale') setNeedsReverify(toolName);
        setNotice(`✗ ${r.message}`);
        return;
      }
      setPlan({ toolName, preview: r.preview, leaks: r.leaks ?? [] });
      setNotice('');
    } catch (err) {
      setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const reverify = async (toolName: string): Promise<void> => {
    setBusy(true);
    setNotice(`… ${toolName} を検証し直しています(型検査・テスト・スモーク)`);
    try {
      const r = await api.pluginsReverify(toolName);
      setNotice(`${r.ok ? '✓' : '✗'} ${r.message}`);
      if (r.ok) {
        setNeedsReverify(null);
        await openPlan(toolName); // 証跡ができた=そのまま公開の下見へ
      }
    } catch (err) {
      setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (draft: boolean): Promise<void> => {
    if (plan === null) return;
    setBusy(true);
    setNotice('… 送信中(fork → ブランチ → PR)');
    try {
      const r = await api.pluginsUpload(plan.toolName, plan.preview, draft);
      setNotice(`${r.ok ? '✓' : '✗'} ${r.message}`);
      if (r.ok) {
        setPlan(null);
        loadPublished();
      }
    } catch (err) {
      setNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openCaps = (): void => {
    setShowCaps(true);
    void api
      .evolutionCapabilities()
      .then(setCaps)
      .catch(() => setCaps([]));
  };

  const sorted = [...jobs].sort((a, b) => b.id - a.id);
  const active = sorted.filter((j) => !DONE.includes(j.status));
  const done = sorted.filter((j) => DONE.includes(j.status));

  const publishable = isPublishableJob;

  const jobRow = (job: (typeof jobs)[number]): JSX.Element => (
    <div key={job.id} className="job">
      <div>
        #{job.id} {job.toolName ?? job.description.slice(0, 40)}
        <span className={`st ${job.status}`}>{job.status}</span>
      </div>
      {publishable(job) &&
        job.toolName !== undefined &&
        (published[job.toolName] !== undefined ? (
          <a className="muted" href={published[job.toolName]!.url} target="_blank" rel="noreferrer">
            ✓ 公開済み ↗
          </a>
        ) : (
          <div className="btnrow">
            <button className="btn-allow" disabled={busy} onClick={() => void openPlan(job.toolName!)}>
              ⛩ 公開
            </button>
          </div>
        ))}
      {job.autoBranch !== undefined && (
        <div className="log">🌙 夜間昇格: {job.autoBranch} に積んである(main 未取り込みのため公開はまだできない)</div>
      )}
      {job.gates.length > 0 && (
        <div className="log">{job.gates.map((g) => `${g.ok ? '✅' : '❌'} ${g.name}`).join(' / ')}</div>
      )}
      {job.error && <div className="log">⚠ {job.error}</div>}
    </div>
  );

  return (
    <div className="content">
      <div ref={feedbackRef} />
      {promotions.length > 0 && (
        <div className="warn-banner" onClick={() => setTab('approvals')}>
          🧬 昇格承認待ちが {promotions.length} 件ある(承認タブで対応)
        </div>
      )}

      {/* 公開の確認 — 送信前に必ず全文を読ませる(岩戸の掟) */}
      {plan !== null && (
        <div className="card">
          <h3>⛩ 公開の確認 — 外部(GitHub)へ送ります</h3>
          {plan.leaks.length > 0 && (
            <p className="log">{`⚠ 機械チェックの検出(このままでは送れません):\n${plan.leaks.join('\n')}`}</p>
          )}
          <pre className="log" style={{ maxHeight: '40vh', overflow: 'auto' }}>
            {plan.preview}
          </pre>
          <div className="btnrow">
            <button className="btn-allow" disabled={busy || plan.leaks.length > 0} onClick={() => void submit(false)}>
              承認して公開
            </button>
            <button disabled={busy} onClick={() => void submit(true)}>
              下書きPRで出す
            </button>
            <button className="btn-deny" onClick={() => setPlan(null)}>
              やめる
            </button>
          </div>
        </div>
      )}

      {/* 証跡が無くて公開できなかった → 今から本物の検証を回せる */}
      {needsReverify !== null && plan === null && (
        <div className="card">
          <p>「{needsReverify}」は検証の証跡がありません(以前に作られたツール)</p>
          <div className="btnrow">
            <button className="btn-allow" disabled={busy} onClick={() => void reverify(needsReverify)}>
              🔍 検証し直して公開可能にする
            </button>
            <button onClick={() => setNeedsReverify(null)}>あとで</button>
          </div>
        </div>
      )}

      <div className="card enqueue">
        <h3>新しい能力をリクエスト</h3>
        <textarea
          rows={2}
          placeholder="欲しいツールの説明(例: CSVをMarkdown表にする)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <input
          placeholder="期待する入出力(例: 入力=CSV文字列 / 出力=Markdown)"
          value={expectedIO}
          onChange={(e) => setExpectedIO(e.target.value)}
        />
        <div className="btnrow">
          <button className="btn-allow" disabled={!description.trim()} onClick={() => void enqueue()}>
            進化ジョブを投入
          </button>
        </div>
      </div>

      {notice && <p className="muted">{notice}</p>}

      {/* 現役のジョブだけ常時表示。終わったものは畳む(スマホの縦スクロールを短く) */}
      {active.length === 0 && <p className="muted">実行中のジョブは無い。</p>}
      {active.map(jobRow)}

      {done.length > 0 && (
        <button className="archive-toggle" onClick={() => setShowDone(!showDone)}>
          📁 完了済みジョブ({done.length}件){showDone ? ' ▲' : ' ▼'}
        </button>
      )}
      {showDone && done.map(jobRow)}

      <button className="archive-toggle" onClick={() => (showCaps ? setShowCaps(false) : openCaps())}>
        🏅 獲得した能力(昇格履歴){showCaps ? ' ▲' : ' ▼'}
      </button>
      {showCaps &&
        (caps.length === 0 ? (
          <p className="muted">昇格履歴なし</p>
        ) : (
          caps.map((h) => (
            <div key={h.tag} className="job">
              <div>
                {h.tag} <span className="muted">{h.date.slice(0, 10)}</span>
                <span className={`st ${h.kind === 'tool' ? 'done' : 'verifying'}`}>{h.kind}</span>
              </div>
              <div className="log">{h.toolNames.length > 0 ? h.toolNames.join(' / ') : h.subject}</div>
            </div>
          ))
        ))}
    </div>
  );
}
