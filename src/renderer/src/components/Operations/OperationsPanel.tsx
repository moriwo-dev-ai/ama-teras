import { useCallback, useEffect, useState } from 'react';
import type {
  CommunityCandidate,
  MediaStrategyEntry,
  MetricsSnapshot,
  OperationsDraft,
  RepoMetrics,
  TriageCard,
} from '../../../../shared/types';
import { useOperationsStore } from '../../stores/operations';

/**
 * M32: 右ペイン「運営」タブ — Project TAKAMA-gahara。
 * 三神(OMOI-kami/AMENO-uzume/TEDIKA-rao)+アダプタ状態。
 * オーナーモードOFF時はこのコンポーネント自体がマウントされない(RightPaneでゲート)。
 */

function CopyButton({ text, label = 'コピー' }: { text: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-[10px] hover:bg-zinc-800"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? '✓ コピーした' : label}
    </button>
  );
}

function Section({
  title,
  kana,
  role,
  children,
}: {
  title: string;
  kana: string;
  role: string;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-md border border-zinc-800">
      <button
        className="flex w-full items-baseline gap-2 px-2 py-1.5 text-left hover:bg-zinc-900"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-xs font-semibold text-zinc-200">
          {open ? '▾' : '▸'} {title}
        </span>
        <span className="text-[10px] text-zinc-500">
          {kana} — {role}
        </span>
      </button>
      {open && <div className="space-y-2 border-t border-zinc-800 p-2">{children}</div>}
    </div>
  );
}

function delta(cur: number | undefined, prev: number | undefined): string {
  if (cur === undefined) return '';
  if (prev === undefined) return `${cur}`;
  const d = cur - prev;
  return d === 0 ? `${cur}` : `${cur} (${d > 0 ? '⬆+' : '⬇'}${d})`;
}

function MetricsView({ current, previous }: { current: MetricsSnapshot; previous: MetricsSnapshot | null }): JSX.Element {
  return (
    <div className="space-y-2">
      {Object.entries(current.github).map(([repo, m]) => {
        const p: RepoMetrics | undefined = previous?.github[repo];
        return (
          <div key={repo} className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
            <div className="mb-1 font-semibold text-zinc-200">{repo}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-zinc-400">
              <span>★ {delta(m.stars, p?.stars)}</span>
              <span>fork {delta(m.forks, p?.forks)}</span>
              <span>issue {delta(m.openIssues, p?.openIssues)}</span>
              <span>PR {delta(m.openPRs, p?.openPRs)}</span>
              {m.views !== undefined && <span>閲覧 {delta(m.views, p?.views)}(u{m.viewsUnique})</span>}
              {m.clones !== undefined && <span>clone {delta(m.clones, p?.clones)}</span>}
              {m.downloads !== undefined && <span>DL {delta(m.downloads, p?.downloads)}</span>}
            </div>
            {m.referrers !== undefined && m.referrers.length > 0 && (
              <div className="mt-1 text-[10px] text-zinc-500">
                流入: {m.referrers.slice(0, 5).map((r) => `${r.referrer}(${r.count})`).join(' / ')}
              </div>
            )}
          </div>
        );
      })}
      {Object.entries(current.zenn).map(([slug, m]) => {
        const p = previous?.zenn[slug];
        return (
          <div key={slug} className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
            <span className="font-semibold text-zinc-200">zenn/{slug}</span>{' '}
            <span>♥ {delta(m.liked, p?.liked)}</span> <span>💬 {delta(m.comments, p?.comments)}</span>
          </div>
        );
      })}
      {current.registry && (
        <p className="text-[10px] text-zinc-500">レジストリ公開プラグイン: {current.registry.plugins}件</p>
      )}
    </div>
  );
}

const DRAFT_KIND_LABEL: Record<OperationsDraft['kind'], string> = {
  'x-post': 'X投稿',
  'release-note': 'リリースノート',
  'article-outline': '記事アウトライン',
  reply: '返信',
  'weekly-report': '週報',
};

function DraftCard({ draft, onUpdate }: { draft: OperationsDraft; onUpdate: () => void }): JSX.Element {
  const [media, setMedia] = useState(draft.media ?? 'x');
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[10px]">{DRAFT_KIND_LABEL[draft.kind]}</span>
        <span className="min-w-0 flex-1 truncate font-semibold text-zinc-200">{draft.title}</span>
        {draft.status === 'posted' && (
          <span className="text-[10px] text-green-400">✓ 投稿済み({draft.postedAt?.slice(0, 10)})</span>
        )}
      </div>
      <pre className="mb-1 max-h-40 overflow-auto whitespace-pre-wrap text-zinc-300">{draft.body}</pre>
      <div className="flex flex-wrap items-center gap-1.5">
        <CopyButton text={draft.body} />
        {draft.status === 'draft' && (
          <>
            <select
              className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[10px]"
              value={media}
              onChange={(e) => setMedia(e.target.value)}
            >
              {['x', 'zenn', 'hatena', 'hn', 'reddit', 'bluesky', 'github'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              className="rounded border border-green-800 px-2 py-0.5 text-[10px] text-green-300 hover:bg-green-950"
              title="人間が実際に投稿したあとに押す(OMOI-kamiの反応突き合わせに使う)"
              onClick={() => {
                void window.api.operationsDraftUpdate(draft.id, { status: 'posted', media }).then(onUpdate);
              }}
            >
              投稿済みにする
            </button>
            <button
              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              onClick={() => {
                void window.api.operationsDraftUpdate(draft.id, { status: 'discarded' }).then(onUpdate);
              }}
            >
              破棄
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TriageCardView({ card }: { card: TriageCard }): JSX.Element {
  const [sendState, setSendState] = useState<string | null>(null);
  const sev = (s: 'high' | 'medium' | 'low'): string =>
    s === 'high' ? 'text-red-400' : s === 'medium' ? 'text-amber-400' : 'text-zinc-400';
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${card.kind === 'pr' ? 'bg-purple-800' : 'bg-sky-800'}`}>
          {card.kind === 'pr' ? 'PR' : 'Issue'}
        </span>
        <span className="font-semibold text-zinc-200">
          {card.repo}#{card.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-400">{card.title}</span>
        <span className="text-[10px] text-zinc-500">@{card.author}</span>
      </div>
      <p className="mb-1 text-zinc-300">{card.summary}</p>
      {card.findings.length > 0 && (
        <ul className="mb-1 space-y-0.5">
          {card.findings.map((f, i) => (
            <li key={i} className={sev(f.severity)}>
              [{f.severity}] {f.note}
            </li>
          ))}
        </ul>
      )}
      {card.ci !== undefined && card.ci.length > 0 && (
        <div className="mb-1 text-[10px] text-zinc-500">
          CI: {card.ci.map((c) => `${c.name}=${c.conclusion || c.status}`).join(' / ')}
        </div>
      )}
      <p className="mb-1 text-[10px] text-zinc-500">推奨: {card.recommendation}</p>
      {card.replyDraft !== '' && (
        <pre className="mb-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-zinc-800 p-1.5 text-zinc-300">
          {card.replyDraft}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {card.replyDraft !== '' && (
          <>
            <CopyButton text={card.replyDraft} label="返信をコピー" />
            <button
              className="rounded border border-orange-800 px-2 py-0.5 text-[10px] text-orange-300 hover:bg-orange-950"
              onClick={() => {
                setSendState('承認待ち…');
                void window.api
                  .operationsExecute('github', 'comment', `${card.repo}#${card.number}`, card.replyDraft, {
                    repo: card.repo,
                    number: card.number,
                    kind: card.kind,
                    body: card.replyDraft,
                  })
                  .then((r) => setSendState(r.ok ? '✓ 送信した' : `✗ ${r.detail}`));
              }}
            >
              ⛩ 返信を送信(承認ダイアログ)
            </button>
          </>
        )}
        {card.labels.length > 0 && (
          <button
            className="rounded border border-orange-800 px-2 py-0.5 text-[10px] text-orange-300 hover:bg-orange-950"
            onClick={() => {
              setSendState('承認待ち…');
              void window.api
                .operationsExecute(
                  'github',
                  'label',
                  `${card.repo}#${card.number}`,
                  `ラベル付与: ${card.labels.join(', ')}`,
                  { repo: card.repo, number: card.number, labels: card.labels },
                )
                .then((r) => setSendState(r.ok ? '✓ 付与した' : `✗ ${r.detail}`));
            }}
          >
            ⛩ ラベル {card.labels.join(',')} を付与
          </button>
        )}
        {sendState !== null && <span className="text-[10px] text-zinc-400">{sendState}</span>}
      </div>
    </div>
  );
}

function CandidateCard({ c, onUpdate }: { c: CommunityCandidate; onUpdate: () => void }): JSX.Element {
  const verdictLabel =
    c.verdict === 'match' ? '✓ 仲間候補' : c.verdict === 'no-match' ? '✗ 対象外' : '? 判断保留';
  const verdictCls =
    c.verdict === 'match' ? 'text-green-400' : c.verdict === 'no-match' ? 'text-zinc-500' : 'text-amber-400';
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className={`font-semibold ${verdictCls}`}>{verdictLabel}</span>
        <span className="text-[10px] text-zinc-500">{c.source}</span>
        {c.status !== 'new' && <span className="text-[10px] text-zinc-500">({c.status === 'kept' ? '保存済み' : '破棄'})</span>}
      </div>
      <p className="mb-1 max-h-16 overflow-hidden text-ellipsis text-[10px] text-zinc-500">{c.profile.slice(0, 200)}</p>
      <ul className="mb-1 space-y-0.5 text-zinc-300">
        {c.reasons.map((r, i) => (
          <li key={i}>・{r}</li>
        ))}
      </ul>
      {c.replyDraft !== undefined && (
        <div className="mb-1">
          <p className="text-[10px] text-zinc-500">返信下書き(宣伝ではなく内容への反応。投稿は人間):</p>
          <pre className="whitespace-pre-wrap rounded border border-zinc-800 p-1.5 text-zinc-300">{c.replyDraft}</pre>
        </div>
      )}
      <div className="flex gap-1.5">
        {c.replyDraft !== undefined && <CopyButton text={c.replyDraft} label="返信をコピー" />}
        {c.status === 'new' && (
          <>
            <button
              className="rounded border border-green-800 px-2 py-0.5 text-[10px] text-green-300 hover:bg-green-950"
              onClick={() => void window.api.operationsCandidateResolve(c.id, 'kept').then(onUpdate)}
            >
              残す
            </button>
            <button
              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              onClick={() => void window.api.operationsCandidateResolve(c.id, 'discarded').then(onUpdate)}
            >
              破棄
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function OperationsPanel(): JSX.Element {
  const { ghDetected, adapters, refresh } = useOperationsStore();
  const [history, setHistory] = useState<MetricsSnapshot[]>([]);
  const [drafts, setDrafts] = useState<OperationsDraft[]>([]);
  const [candidates, setCandidates] = useState<CommunityCandidate[]>([]);
  const [board, setBoard] = useState<MediaStrategyEntry[]>([]);
  const [triage, setTriage] = useState<TriageCard[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keywords, setKeywords] = useState('AIエージェント 自作');
  const [searchResult, setSearchResult] = useState<Awaited<
    ReturnType<typeof window.api.operationsDiscoverySearch>
  > | null>(null);
  const [pasteText, setPasteText] = useState('');

  const reload = useCallback((): void => {
    void window.api.operationsHistory(30).then(setHistory);
    void window.api.operationsDraftsList().then(setDrafts);
    void window.api.operationsCandidatesList().then(setCandidates);
    void window.api.operationsStrategyBoard().then(setBoard);
  }, []);

  useEffect(() => {
    void refresh();
    reload();
  }, [refresh, reload]);

  const run = (label: string, fn: () => Promise<unknown>): void => {
    setBusy(label);
    setError(null);
    void fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  const current = history[history.length - 1] ?? null;
  const previous = history.length >= 2 ? (history[history.length - 2] ?? null) : null;
  const activeDrafts = drafts.filter((d) => d.status !== 'discarded').reverse();
  const activeCandidates = candidates.filter((c) => c.status !== 'discarded').reverse();

  return (
    <div className="space-y-2 p-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">⛩ Project TAKAMA-gahara</h2>
        <span className="text-[10px] text-zinc-500">運営(オーナーモード)</span>
      </div>

      {!ghDetected && (
        <div className="rounded border border-amber-700 bg-amber-950 p-2 text-xs text-amber-200">
          gh CLI が見つからないため GitHub の観測・実行は無効です。
          <code className="mx-1">winget install GitHub.cli</code>で導入し、
          <code className="mx-1">gh auth login</code>で認証してください
        </div>
      )}

      {/* AMANO-iwate: アダプタ状態 */}
      <div className="flex flex-wrap gap-1.5">
        {adapters.map((a) => (
          <span
            key={a.id}
            title={`${a.compliance}${a.detail !== undefined ? `\n${a.detail}` : ''}`}
            className={`rounded-full border px-2 py-0.5 text-[10px] ${
              a.available ? 'border-zinc-600 text-zinc-300' : 'border-zinc-800 text-zinc-600'
            }`}
          >
            {a.available ? '●' : '○'} {a.id}
            {a.capabilities.execute.length === 0 ? '(提案のみ)' : ''}
          </span>
        ))}
      </div>

      {error !== null && (
        <div className="rounded border border-red-800 bg-red-950 p-2 text-xs text-red-300">{error}</div>
      )}

      <Section title="OMOI-kami" kana="オモイカネ" role="観測と戦略">
        <div className="flex flex-wrap gap-1.5">
          <button
            className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => run('snapshot', () => window.api.operationsSnapshot())}
          >
            {busy === 'snapshot' ? '収集中…' : '📊 今すぐ収集'}
          </button>
          <button
            className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => run('weekly', () => window.api.operationsWeeklyReport())}
          >
            {busy === 'weekly' ? '生成中…' : '📝 週報を生成'}
          </button>
        </div>
        {current !== null ? (
          <MetricsView current={current} previous={previous} />
        ) : (
          <p className="text-xs text-zinc-500">まだ観測データが無い。「今すぐ収集」から始める</p>
        )}
        {history.length >= 2 && (
          <p className="text-[10px] text-zinc-500">時系列: {history.length}件(userData/operations/metrics.jsonl)</p>
        )}
      </Section>

      <Section title="AMENO-uzume" kana="アメノウズメ" role="広報と仲間探し">
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => run('drafts', () => window.api.operationsDraftsGenerate())}
        >
          {busy === 'drafts' ? '生成中…' : '💃 見せ場から発信ドラフトを生成'}
        </button>
        {activeDrafts.length > 0 && (
          <div className="space-y-1.5">
            {activeDrafts.map((d) => (
              <DraftCard key={d.id} draft={d} onUpdate={reload} />
            ))}
          </div>
        )}

        <details>
          <summary className="cursor-pointer text-xs text-zinc-400">📋 メディア戦略ボード</summary>
          <div className="mt-1 space-y-1">
            {board.map((e) => (
              <div key={e.media} className="rounded border border-zinc-800 bg-zinc-950 p-1.5 text-[10px]">
                <span className="font-semibold text-zinc-200">{e.media}</span>
                <span className="ml-1 text-zinc-500">({e.audience})</span>
                <div className="text-zinc-400">→ {e.nextAction}</div>
                <div className="text-zinc-600">{e.note}</div>
              </div>
            ))}
          </div>
        </details>

        <details>
          <summary className="cursor-pointer text-xs text-zinc-400">🔍 仲間発見(コミュニティ・ディスカバリー)</summary>
          <div className="mt-1 space-y-2">
            <div className="flex gap-1.5">
              <input
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="検索キーワード(スペース区切り)"
              />
              <button
                className="shrink-0 rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
                onClick={() =>
                  void window.api.operationsDiscoverySearch(keywords.split(/\s+/)).then(setSearchResult)
                }
              >
                検索
              </button>
            </div>
            {searchResult !== null && (
              <div className="space-y-1 text-xs">
                {searchResult.x.map((s) => (
                  <div key={s.url} className="flex items-center gap-1.5">
                    <a className="text-blue-400 hover:underline" href={s.url} target="_blank" rel="noreferrer">
                      {s.label} ↗
                    </a>
                    <span className="text-[10px] text-zinc-600">(Xはブラウザで開いて人間が見る)</span>
                  </div>
                ))}
                {searchResult.bluesky.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-zinc-500">Bluesky公開検索:</p>
                    {searchResult.bluesky.map((p) => (
                      <div key={p.uri} className="rounded border border-zinc-800 bg-zinc-950 p-1.5 text-[10px]">
                        <span className="font-semibold text-zinc-300">@{p.handle}</span>
                        <p className="text-zinc-400">{p.text.slice(0, 200)}</p>
                        <button
                          className="mt-0.5 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] hover:bg-zinc-800"
                          onClick={() => setPasteText(`@${p.handle} (${p.author})\n${p.text}`)}
                        >
                          ↓ 解析欄へ
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="space-y-1">
              <textarea
                className="h-20 w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-xs"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="プロフィール/投稿テキストを貼り付けて「本当にAIを楽しんでいる人か」をLLM評価"
              />
              <button
                className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
                disabled={busy !== null || pasteText.trim() === ''}
                onClick={() =>
                  run('candidate', () => window.api.operationsCandidateAnalyze(pasteText, 'paste').then(() => setPasteText('')))
                }
              >
                {busy === 'candidate' ? '評価中…' : '🔮 貼り付けを解析'}
              </button>
            </div>
            {activeCandidates.length > 0 && (
              <div className="space-y-1.5">
                {activeCandidates.map((c) => (
                  <CandidateCard key={c.id} c={c} onUpdate={reload} />
                ))}
              </div>
            )}
          </div>
        </details>
      </Section>

      <Section title="TEDIKA-rao" kana="タヂカラオ" role="門番(Issue/PRトリアージ)">
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
          disabled={busy !== null || !ghDetected}
          onClick={() => run('triage', () => window.api.operationsTriage().then(setTriage))}
        >
          {busy === 'triage' ? 'トリアージ中…' : '💪 オープンIssue/PRをトリアージ'}
        </button>
        {triage.length > 0 ? (
          <div className="space-y-1.5">
            {triage.map((c) => (
              <TriageCardView key={c.id} card={c} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            実行するとオープンIssue/PRを取得し、severity方式でレビューして返信下書き付きのカードにする。
            コメント/ラベル/マージの実行は必ず岩戸ゲート(承認ダイアログ)を通る
          </p>
        )}
      </Section>
    </div>
  );
}
