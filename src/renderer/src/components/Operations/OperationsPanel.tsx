import { useCallback, useEffect, useState } from 'react';
import type {
  CommunityCandidate,
  GodClockJob,
  ImpactEntry,
  InboxItem,
  MediaStrategyEntry,
  MetricsSnapshot,
  OperationsDraft,
  RegistryGodInfo,
  RepoMetrics,
  TriageCard,
} from '../../../../shared/types';
import { useOperationsStore } from '../../stores/operations';
import { draftActionsFor } from './draftActions';
import { firstUrl, hatenaPanelUrl, xIntentUrl } from './postLinks';

/**
 * M33: 神々の時計(ダッシュボード)。会話・承認は左の⛩運営スレッドへ(ここには置かない)。
 * M39: 進行役として AMENO-koyane(天児屋命=祝詞・司会進行)の名を与えた
 */
function GodClocks(): JSX.Element {
  const [jobs, setJobs] = useState<GodClockJob[]>([]);
  const reload = useCallback((): void => {
    void window.api.operationsClocks().then(setJobs);
  }, []);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  const GOD_LABEL: Record<string, string> = {
    'omoi-kami': '🧠 OMOI-kami(観測)',
    'uzume-patrol': '💃 AMENO-uzume(巡回)',
    'uzume-drafts': '💃 AMENO-uzume(下書き)',
    'tedika-rao': '💪 TEDIKA-rao(門番)',
    kamuhakari: '⛩ 神議(戦略会議)',
    kuebiko: '🪆 KUE-biko(要望の目利き)',
  };
  if (jobs.length === 0) return <p className="text-xs text-zinc-500">時計は次回アプリ再起動後に動き出す</p>;
  return (
    <div className="space-y-1">
      {jobs.map((j) => (
        <div key={j.id} className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-950 p-1.5 text-[10px]">
          <button
            className={`rounded px-1.5 py-0.5 ${j.enabled ? 'bg-green-900 text-green-300' : 'bg-zinc-800 text-zinc-500'}`}
            title="クリックで有効/無効"
            onClick={() => void window.api.operationsClockUpdate(j.id, { enabled: !j.enabled }).then(reload)}
          >
            {j.enabled ? '● 稼働' : '○ 停止'}
          </button>
          <span className="font-semibold text-zinc-200">{GOD_LABEL[j.godId] ?? j.godId}</span>
          {/* M42-6: 定刻を待たずに1回動かす(スマホには既にあったが、デスクトップに無かった) */}
          <button
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800"
            title="この神を今すぐ1回実行する(定刻を待たない)"
            onClick={() => void window.api.operationsGodRun(j.godId).then(reload)}
          >
            ▶ 今すぐ
          </button>
          <span className="text-zinc-500">
            {j.dailyTimes !== undefined ? `毎日 ${j.dailyTimes.join('/')}` : `${j.intervalMin}分ごと`}
          </span>
          {j.nextRun !== undefined && <span className="text-zinc-500">次回 {j.nextRun.slice(11, 16)}</span>}
          <span className="ml-auto flex items-center gap-1 text-zinc-500">
            今日 {j.spentToday.toLocaleString()} /
            {/* M36-1: 予算の手動設定(ユーザーの設定行為=承認不要。以後は神議の自律調整より優先) */}
            <input
              type="number"
              min={0}
              step={1000}
              key={`${j.id}:${j.dailyTokenBudget}`}
              className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-right text-[10px]"
              defaultValue={j.dailyTokenBudget}
              title="1日トークン予算(0=無制限)。手動設定すると神議の自律調整より優先される"
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0 && v !== j.dailyTokenBudget) {
                  void window.api.operationsClockUpdate(j.id, { dailyTokenBudget: v }).then(reload);
                }
              }}
            />
            tok
            {/* M38-1: 施錠/解錠トグル。🔒=あなたの設定が優先 / 🔓=神議に調整権限を返す */}
            <button
              className="ml-0.5 rounded px-0.5 hover:bg-zinc-800"
              title={
                j.budgetSetByUser === true
                  ? '🔒 あなたの手動設定が神議の自律調整より優先されている。クリックで解錠(神議に予算の調整権限を返す)'
                  : '🔓 予算は神議が自律調整できる状態。予算欄に数値を入れると自動で施錠される'
              }
              onClick={() => {
                if (j.budgetSetByUser !== true) return; // 施錠は予算設定と同時にしか起きない
                void window.api
                  .operationsClockUpdate(j.id, { budgetSetByUser: false })
                  .then(reload);
              }}
            >
              {j.budgetSetByUser === true ? '🔒' : '🔓'}
            </button>
          </span>
        </div>
      ))}
      <p className="text-[10px] text-zinc-600">
        予算は0=無制限。手動で設定した予算(🔒)は神議の自律調整より優先される。
        🔒をクリックすると解錠(🔓)し、神議に予算の調整権限を返す(値はそのまま)。
        間隔の調整は神議が自律で行う(予算引き上げの提案はあなたの承認制)。会話は左の⛩運営スレッドで
      </p>
      <GodRegistryView />
      <GodDefEditor />
    </div>
  );
}

/**
 * M42-3: レジストリで配布されている神を探して迎える。神は「コード」ではなく定義データなので、
 * 配布も取り込みも定義JSON1枚で済む。迎え入れは必ず岩戸ゲート(定義JSON全文の確認)を通る。
 * 自分の神は書き出してレジストリへPRできる(共有の入口)
 */
function GodRegistryView(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [gods, setGods] = useState<RegistryGodInfo[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = (q: string): void => {
    setBusy(true);
    setNotice(null);
    void window.api
      .operationsGodRegistry(q === '' ? undefined : q)
      .then((list) => setGods(list))
      .catch(() => setGods([]))
      .finally(() => setBusy(false));
  };

  return (
    <details
      onToggle={(e) => {
        const isOpen = (e.target as HTMLDetailsElement).open;
        setOpen(isOpen);
        if (isOpen && gods === null) search('');
      }}
    >
      <summary className="cursor-pointer text-[10px] text-zinc-500">⛩ レジストリから神を迎える(コミュニティの神定義)</summary>
      {open && (
        <div className="mt-1 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <input
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px]"
              placeholder="どんな神が欲しい?(例: リリース作業を任せたい)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') search(query.trim());
              }}
            />
            <button
              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              disabled={busy}
              onClick={() => search(query.trim())}
            >
              {busy ? '検索中…' : '探す'}
            </button>
          </div>
          {gods !== null && gods.length === 0 && (
            <p className="text-[10px] text-zinc-500">
              レジストリに神は見つからなかった(未公開・不達・該当なし)。神議が新設を提案することもある
            </p>
          )}
          {gods?.map((g) => (
            <div key={g.id} className="rounded border border-zinc-800 p-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-200">
                  {g.name} <span className="text-zinc-500">({g.id} / engine={g.engine})</span>
                </span>
                <button
                  className="shrink-0 rounded border border-orange-800 px-2 py-0.5 text-[10px] text-orange-300 hover:bg-orange-950 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setNotice(`「${g.name}」の定義を取得中…(承認ダイアログで全文を確認できる)`);
                    void window.api
                      .operationsGodInstall(g.id)
                      .then((r) => setNotice(`${r.ok ? '✓' : '✗'} ${r.detail}`))
                      .finally(() => setBusy(false));
                  }}
                >
                  ⛩ 迎える(承認ダイアログ)
                </button>
              </div>
              <p className="mt-0.5 text-[10px] text-zinc-400">{g.description}</p>
              <p className="mt-0.5 text-[10px] text-zinc-500">
                {g.verified ? '✅ 検証済み' : '⚠ 未検証'} / 作者: {g.author || '不明'}
                {g.version !== '' ? ` / v${g.version}` : ''}
              </p>
            </div>
          ))}
          {notice !== null && <p className="text-[10px] text-zinc-400">{notice}</p>}
          <p className="text-[10px] text-zinc-500">
            迎え入れは定義JSONの全文を承認ダイアログで確認してから。自分の神を共有するには
            下の「神の定義」から書き出して、レジストリへPRする
          </p>
        </div>
      )}
    </details>
  );
}

/** M33-5: 神の定義エディタ(最小: JSON表示+検証+申請)。適用は承認ダイアログ必須 */
function GodDefEditor(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const load = (): void => {
    void window.api.operationsGodDefs().then((defs) => setJson(JSON.stringify(defs, null, 1)));
  };
  return (
    <details
      onToggle={(e) => {
        const isOpen = (e.target as HTMLDetailsElement).open;
        setOpen(isOpen);
        if (isOpen && json === '') load();
      }}
    >
      <summary className="cursor-pointer text-[10px] text-zinc-500">⚙ 神の定義(JSON。新設・改造は承認ダイアログ必須)</summary>
      {open && (
        <div className="mt-1 space-y-1">
          <textarea
            className="h-40 w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-[10px]"
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <div className="flex items-center gap-1.5">
            <button
              className="rounded border border-orange-800 px-2 py-0.5 text-[10px] text-orange-300 hover:bg-orange-950"
              onClick={() => {
                try {
                  const parsed: unknown = JSON.parse(json);
                  const defs = Array.isArray(parsed) ? parsed : [parsed];
                  setNotice('申請中…(定義ごとに承認ダイアログが出る)');
                  void (async () => {
                    const results: string[] = [];
                    for (const def of defs) {
                      const r = await window.api.operationsGodDefApply(def);
                      results.push(`${(def as { id?: string }).id ?? '?'}: ${r.ok ? '✓' : '✗'} ${r.detail}`);
                    }
                    setNotice(results.join(' / '));
                    load();
                  })();
                } catch (err) {
                  setNotice(`JSONが不正: ${err instanceof Error ? err.message : String(err)}`);
                }
              }}
            >
              ⛩ 変更を申請(承認ダイアログ)
            </button>
            <button className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800" onClick={load}>
              再読込
            </button>
            {/* M42-3: レジストリへPRするための書き出し(共有の入口。秘密は定義に含まれない) */}
            <button
              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              onClick={() => {
                const id = window.prompt('書き出す神のid(例: saruta-hiko)');
                if (id === null || id.trim() === '') return;
                void window.api
                  .operationsGodExport(id.trim())
                  .then((r) => setNotice(`${r.ok ? '✓' : '✗'} ${r.message}`));
              }}
            >
              📤 定義を書き出す(レジストリへPR)
            </button>
          </div>
          {notice !== null && <p className="text-[10px] text-zinc-400">{notice}</p>}
        </div>
      )}
    </details>
  );
}

/** M33: 受け箱(ダッシュボード) */
function InboxView(): JSX.Element {
  const [items, setItems] = useState<(InboxItem & { read: boolean })[]>([]);
  const reload = useCallback((): void => {
    void window.api.operationsInboxList(50).then(setItems);
  }, []);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  const KIND_ICON: Record<string, string> = {
    metrics: '📊',
    candidate: '🔍',
    draft: '📝',
    triage: '💪',
    'budget-alert': '⚠',
    'kamuhakari-report': '⛩',
  };
  if (items.length === 0) return <p className="text-xs text-zinc-500">受け箱は空(神々の成果物がここに届く)</p>;
  return (
    <div className="max-h-60 space-y-0.5 overflow-y-auto">
      {items.map((i) => (
        <div key={i.id} className={`flex items-baseline gap-1.5 rounded p-1 text-[10px] ${i.read ? 'text-zinc-600' : 'text-zinc-300'}`}>
          <span>{KIND_ICON[i.kind] ?? '・'}</span>
          <span className="shrink-0 text-zinc-600">{i.ts.slice(5, 16)}</span>
          <span className="min-w-0 flex-1">{i.title}</span>
        </div>
      ))}
    </div>
  );
}

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
      {/* M34-1/2: はてブ数・HN karma(前回比つき) */}
      {current.hatena !== undefined && (
        <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
          {Object.entries(current.hatena).map(([url, count]) => (
            <div key={url} className="flex gap-2">
              <span className="font-semibold text-zinc-300">B! {delta(count, previous?.hatena?.[url])}</span>
              <span className="min-w-0 truncate text-zinc-600">{url.replace(/^https?:\/\//, '')}</span>
            </div>
          ))}
        </div>
      )}
      {current.hn?.karma !== undefined && (
        <p className="text-xs text-zinc-400">
          <span className="font-semibold text-zinc-300">HN karma {delta(current.hn.karma, previous?.hn?.karma)}</span>
        </p>
      )}
      {current.registry && (
        <p className="text-[10px] text-zinc-500">レジストリ公開プラグイン: {current.registry.plugins}件</p>
      )}
      {/* M34-3: X告知の扱い(誤解防止の固定注記) */}
      <p className="rounded border border-zinc-800 bg-zinc-950 p-1.5 text-[10px] text-zinc-500">
        ℹ X(Twitter)関連の反応はアプリでは監視できません(規約上、自動取得を行いません)。
        Xアプリの通知で確認してください
      </p>
    </div>
  );
}

/**
 * M38-3: 発信の効果測定(投稿 → 前後メトリクス差分)。
 * 神議が要求した「どの投稿がどの変化を生んだか」の受け皿。相関であって因果ではない
 */
function ImpactView(): JSX.Element | null {
  const [entries, setEntries] = useState<ImpactEntry[]>([]);
  useEffect(() => {
    void window.api.operationsImpacts().then(setEntries);
  }, []);
  if (entries.length === 0) return null;
  const fmt = (d: ImpactEntry['delta']): string => {
    if (d === null) return '';
    const parts: string[] = [];
    const push = (label: string, v: number): void => {
      if (v !== 0) parts.push(`${label}${v > 0 ? '+' : ''}${v}`);
    };
    push('★', d.stars);
    push('Zenn♥', d.zennLiked);
    push('💬', d.zennComments);
    push('B!', d.hatena);
    push('DL', d.downloads);
    push('閲覧', d.views);
    return parts.length > 0 ? parts.join(' / ') : '変化なし(±0)';
  };
  return (
    <div className="space-y-1 rounded border border-zinc-800 bg-zinc-950 p-2">
      <p className="text-xs font-semibold text-zinc-300">発信の効果(投稿前後の差分)</p>
      {entries.map((e) => (
        <div key={e.draftId} className="text-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
              {e.media ?? '媒体不明'}
            </span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{e.title}</span>
            <span className={e.measurable ? 'text-green-400' : 'text-zinc-500'}>
              {e.measurable ? fmt(e.delta) : e.note}
            </span>
          </div>
          <p className="text-[10px] text-zinc-600">
            {e.postedAt.slice(0, 16).replace('T', ' ')} 投稿 / 計測窓{e.windowHours}h
            {e.url !== null && (
              <>
                {' '}
                ·{' '}
                <button
                  className="underline hover:text-zinc-400"
                  onClick={() => void window.api.openExternal(e.url ?? '')}
                >
                  投稿先URL
                </button>
              </>
            )}
          </p>
        </div>
      ))}
      <p className="text-[10px] text-zinc-600">
        ※ 相関であって因果ではない(同時期の他要因は排除できない)。判断材料としてのみ使う
      </p>
    </div>
  );
}

const DRAFT_KIND_LABEL: Record<OperationsDraft['kind'], string> = {
  'x-post': 'X投稿',
  'release-note': 'リリースノート',
  'article-outline': '記事アウトライン',
  'article-body': 'Zenn記事本文',
  reply: '返信',
  'weekly-report': '週報',
};

/** M37: リリースノート → GitHub Release(下書き)。repo/tagを添えて岩戸ゲートへ */
function ReleaseAction({ draft }: { draft: OperationsDraft }): JSX.Element {
  const repos = useOperationsStore((s) => s.repos);
  const [repo, setRepo] = useState(repos[0] ?? '');
  // 本文中の vX.Y.Z を初期タグ候補にする(人間が直せる)
  const [tag, setTag] = useState(/v\d+\.\d+\.\d+/.exec(draft.body)?.[0] ?? '');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // M47: 既定ON。リリースのたびに package.json を上げるのを人間の記憶に頼らない
  const [bump, setBump] = useState(true);
  // M46: 前回の版を人間が覚えなくてよくする。GitHubの最新リリースから次の版を機械的に出す
  const [info, setInfo] = useState<{
    latestTag: string | null;
    appVersion: string;
    suggestions: { patch: string | null; minor: string | null; major: string | null };
    mismatch: boolean;
    pendingDraft: { tag: string; assets: string[] } | null;
  } | null>(null);
  // M85: リリース情報を**repoが変わった時にしか取りに行っていなかった**。アプリを開いたまま
  // 下書きリリースを作ると、UIは起動時に掴んだ pendingDraft: null を持ち続け、
  // 「🚀 公開」ボタンが永久に出ない(実際、v1.2.0の下書きができているのに画面に出なかった)。
  // 一次情報は変わる。定期的に、そして画面に居る間は取り直す
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNonce((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (repo === '') return;
    let alive = true;
    void window.api.operationsReleaseInfo(repo).then((r) => {
      if (!alive) return;
      setInfo(r);
      // 本文にタグが書かれていなければ patch を既定にする(初回リリースならアプリの版)
      setTag((cur) => (cur !== '' ? cur : (r.suggestions.patch ?? `v${r.appVersion}`)));
    });
    return () => {
      alive = false;
    };
  }, [repo, nonce]);
  return (
    <>
      <select
        className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[10px]"
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
      >
        {repos.length === 0 && <option value="">(観測対象リポジトリ未設定)</option>}
        {repos.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <input
        className="w-24 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 font-mono text-[10px]"
        value={tag}
        placeholder="v1.0.1"
        onChange={(e) => setTag(e.target.value)}
      />
      {/* M46: 直近リリースからの自動採番。押すだけで次の版が入る(手入力も可) */}
      {info !== null && (
        <span className="flex items-center gap-1 text-[10px] text-zinc-500">
          {info.latestTag !== null ? `前回 ${info.latestTag} →` : '初回リリース'}
          {(['patch', 'minor', 'major'] as const).map((b) => {
            const v = info.suggestions[b];
            if (v === null) return null;
            return (
              <button
                key={b}
                className={`rounded border px-1 py-0.5 font-mono ${
                  tag === v ? 'border-orange-700 text-orange-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                }`}
                title={`${b}: ${v}`}
                onClick={() => setTag(v)}
              >
                {v}
              </button>
            );
          })}
          {info.mismatch && (
            <span
              className="text-amber-400"
              title={`package.json の version(${info.appVersion})が直近リリース(${info.latestTag})と食い違っています。食い違ったまま出すと、利用者の更新バナーが正しく出ません`}
            >
              ⚠ アプリ版 {info.appVersion}
            </span>
          )}
        </span>
      )}
      {/* M47: リリースのたびに package.json を上げるのは機械の仕事(忘れると更新通知が壊れる) */}
      <label className="flex items-center gap-1 text-[10px] text-zinc-400" title="package.json の version をタグに合わせて上げ、コミット・pushする(承認ダイアログで差分を確認できる)">
        <input type="checkbox" checked={bump} onChange={(e) => setBump(e.target.checked)} />
        package.json も上げる
      </label>
      <button
        className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-[10px] hover:bg-zinc-800 disabled:opacity-40"
        title="承認ダイアログ(何を・どこへ・全文)を経て、GitHub Release を下書きで作成/更新する。公開はGitHub上であなたが行う"
        disabled={busy || repo === '' || tag.trim() === ''}
        onClick={() => {
          setBusy(true);
          setResult(null);
          const v = tag.trim();
          void (async () => {
            try {
              // 先に version を上げる(承認1回)。拒否・失敗したらリリースへ進まない
              if (bump) {
                const b = await window.api.operationsBumpVersion(v);
                if (!b.ok) {
                  setResult(`version 更新に失敗/中止: ${b.detail}`);
                  return;
                }
                setResult(b.detail);
              }
              const r = await window.api.operationsDraftRelease(draft.id, repo, v);
              setResult(r.detail);
            } catch (e: unknown) {
              setResult(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        {busy ? '承認待ち…' : '🐙 GitHub Releaseへ'}
      </button>
      {/* M92-A7: バージョン上げ→ビルド→下書きに.exe添付までを1アクションで(公開はしない・開発版のみ)。
          これ1つで「公開できる状態(インストーラ入り下書き)」まで用意できる */}
      <button
        className="shrink-0 rounded border border-sky-800 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-950 disabled:opacity-40"
        title="承認すると、バージョン上げ→typecheck/テスト→インストーラ(.exe)ビルド→GitHub Release下書きに添付、まで一気に行う(公開はしない)。開発版のみ・数分かかる"
        disabled={busy || repo === '' || tag.trim() === ''}
        onClick={() => {
          setBusy(true);
          setResult(null);
          void window.api
            .operationsReleaseBuild(draft.id, repo, tag.trim())
            .then((r) => {
              setResult(r.detail);
              if (r.ok) setNonce((n) => n + 1); // 添付済み下書きを掴み直して「公開」ボタンを出す
            })
            .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '承認待ち…' : '🔨 ビルドして下書きに添付'}
      </button>
      {/* M48: 公開待ちの下書きがあれば、アプリから公開できる(承認ダイアログを通る)。
          配布物が付いていない下書きは main 側が弾く(更新通知だけ出て落とすものが無い状態を作らない) */}
      {info?.pendingDraft != null && (
        <button
          className="shrink-0 rounded border border-emerald-800 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
          title="下書きリリースを公開する。公開すると全利用者のアプリに更新バナーが出る(承認ダイアログで内容を確認できる)"
          disabled={busy || repo === ''}
          onClick={() => {
            const draftTag = info.pendingDraft?.tag;
            if (draftTag === undefined) return;
            setBusy(true);
            setResult(null);
            void window.api
              .operationsReleasePublish(repo, draftTag)
              .then((r) => setResult(r.detail))
              .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(false));
          }}
        >
          🚀 {info.pendingDraft.tag} を公開({info.pendingDraft.assets.length}件添付)
        </button>
      )}
      {result !== null && <span className="text-[10px] text-zinc-400">{result}</span>}
    </>
  );
}

/** M37: 記事アウトライン → 本文をLLMで起こし、承認後 zenn-content へ published:false でコミット */
function ZennArticleAction({ draft, onUpdate }: { draft: OperationsDraft; onUpdate: () => void }): JSX.Element {
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-[10px] hover:bg-zinc-800 disabled:opacity-40"
        title="アウトラインから本文を下書きし、承認後に zenn-content へ published: false でコミットする(公開はZennの記事設定であなたが行う)"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setResult(null);
          void window.api
            .operationsDraftZennArticle(draft.id)
            .then((r) => setResult(r.detail))
            .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)))
            .finally(() => {
              setBusy(false);
              onUpdate(); // 本文ドラフト(article-body)は承認可否にかかわらず残る
            });
        }}
      >
        {busy ? '本文を執筆中…' : '📝 Zenn記事化(published: false)'}
      </button>
      {result !== null && <span className="text-[10px] text-zinc-400">{result}</span>}
    </>
  );
}

/**
 * M73: 公開待ちのZenn記事(published: false)を公開する。
 * 「記事化」はコミットまでしかせず、そこから先は誰の手も届かないままだった
 * (記事2本が丸一日以上、露出ゼロで放置された)。GitHub Release と同じく岩戸ゲートを通す
 */
/**
 * M86: **公開ボタンが、公開すべき状態になった瞬間に消えていた**。
 * 「🚀 下書きリリースを公開」は下書きカードの操作行(ReleaseAction)の中にあり、
 * その操作行は status === 'draft' のときしか出さない。ところがリリースにした下書きは
 * staged(=GitHubに下書きリリースができた)になるので、まさに公開が要る状態でボタンが消える。
 * 下書きカードから切り離し、Zennの公開(M73)と同じく**独立したセクション**にする
 */
function ReleasePublishSection(): JSX.Element | null {
  const repos = useOperationsStore((s) => s.repos);
  const [pending, setPending] = useState<{ repo: string; tag: string; assets: string[] }[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setNonce((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let alive = true;
    void Promise.all(
      repos.map((repo) =>
        window.api.operationsReleaseInfo(repo).then((r) =>
          r.pendingDraft === null ? null : { repo, tag: r.pendingDraft.tag, assets: r.pendingDraft.assets },
        ),
      ),
    ).then((rows) => {
      if (alive) setPending(rows.filter((r): r is { repo: string; tag: string; assets: string[] } => r !== null));
    });
    return () => {
      alive = false;
    };
  }, [repos, nonce, busy]);

  if (pending.length === 0) return null;
  return (
    <div className="space-y-1 rounded border border-emerald-900 bg-emerald-950/20 p-2">
      <div className="text-[11px] font-semibold text-emerald-300">🚀 公開待ちのリリース — まだ誰も落とせない</div>
      {pending.map((p) => (
        <div key={`${p.repo}:${p.tag}`} className="flex items-center gap-2 text-[10px]">
          <span className="min-w-0 flex-1 truncate text-zinc-300">
            {p.repo} {p.tag}(添付{p.assets.length}件)
          </span>
          <button
            className="shrink-0 rounded border border-emerald-800 px-2 py-0.5 text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
            title="公開すると全利用者のアプリに更新バナーが出る(承認ダイアログで内容を確認できる)"
            disabled={busy !== ''}
            onClick={() => {
              setBusy(p.tag);
              setResult(null);
              void window.api
                .operationsReleasePublish(p.repo, p.tag)
                .then((r) => setResult(r.detail))
                .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(''));
            }}
          >
            {busy === p.tag ? '承認待ち…' : '⛩ 公開する'}
          </button>
        </div>
      ))}
      {result !== null && <div className="text-[10px] text-zinc-400">{result}</div>}
    </div>
  );
}

function ZennPublishSection(): JSX.Element | null {
  const [articles, setArticles] = useState<{ slug: string; title: string; blocked: string | null }[]>([]);
  // M77: published:true にしたのにZennが同期していない記事(投稿数の上限などで止まる)
  const [stuck, setStuck] = useState<{ slug: string; title: string }[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState('');

  const reload = (): void => {
    void window.api
      .operationsZennPublishable()
      .then(setArticles)
      .catch(() => setArticles([]));
    void window.api
      .operationsZennStuck()
      .then(setStuck)
      .catch(() => setStuck([]));
  };
  useEffect(reload, []);
  if (articles.length === 0 && stuck.length === 0) return null;

  return (
    <div className="mt-2 rounded border border-zinc-800 p-2">
      {stuck.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-amber-400">
            ⏳ published: true にしたが、Zennがまだ公開していない(= 誰も読めない)
          </div>
          {stuck.map((a) => (
            <div key={a.slug} className="flex items-center gap-2 py-0.5">
              <span className="truncate text-[11px] text-zinc-300">{a.title}</span>
              <button
                className="shrink-0 rounded border border-amber-800 px-2 py-0.5 text-[10px] text-amber-300 hover:bg-amber-950 disabled:opacity-40"
                title="空コミット+pushでZennの同期をやり直させる(記事の中身は変えない)。投稿数の上限中は、上限が戻るまで反映されない"
                disabled={busy !== ''}
                onClick={() => {
                  setBusy(a.slug);
                  setResult(null);
                  void window.api
                    .operationsZennRedeploy(a.slug)
                    .then((r) => setResult(r.detail))
                    .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)))
                    .finally(() => {
                      setBusy('');
                      reload();
                    });
                }}
              >
                {busy === a.slug ? '承認待ち…' : '🔄 再デプロイ'}
              </button>
            </div>
          ))}
        </div>
      )}
      {articles.length > 0 && (
      <div className="mb-1 text-[10px] text-zinc-400">
        📝 公開待ちのZenn記事(published: false = まだ誰も読めない)
      </div>
      )}
      {articles.map((a) => (
        <div key={a.slug} className="flex items-center gap-2 py-0.5">
          <span className="truncate text-[11px] text-zinc-300">{a.title}</span>
          {a.blocked !== null ? (
            <span className="shrink-0 text-[10px] text-amber-400">🚫 {a.blocked}</span>
          ) : (
            <button
              className="shrink-0 rounded border border-emerald-800 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
              title="published: true にして push する。承認ダイアログで公開される全文を確認できる"
              disabled={busy !== ''}
              onClick={() => {
                setBusy(a.slug);
                setResult(null);
                void window.api
                  .operationsZennPublish(a.slug)
                  .then((r) => setResult(r.detail))
                  .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)))
                  .finally(() => {
                    setBusy('');
                    reload();
                  });
              }}
            >
              {busy === a.slug ? '承認待ち…' : '⛩ 公開する'}
            </button>
          )}
        </div>
      ))}
      {result !== null && <div className="text-[10px] text-zinc-400">{result}</div>}
    </div>
  );
}

/** M84: 「07-14 12:45」。日付が無いと、同じ見出しの下書きのどれが最新か分からない */
function formatDraftTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function DraftCard({ draft, onUpdate }: { draft: OperationsDraft; onUpdate: () => void }): JSX.Element {
  const [media, setMedia] = useState(draft.media ?? 'x');
  // M37: 行き先は種類ごとにコードで固定(Xに載らない種類にXボタンを出さない)
  const actions = draftActionsFor(draft.kind);
  const url = firstUrl(draft.body);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[10px]">{DRAFT_KIND_LABEL[draft.kind]}</span>
        {/* M84: 神々が何本も下書きを積むのに、どれが新しいのかが画面から分からなかった。
            順番が分からないと「どっちを先に出すのか」が判断できない(版の採番は順番で変わる) */}
        <span className="shrink-0 text-[10px] text-zinc-500" title={draft.createdAt}>
          {formatDraftTime(draft.createdAt)}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold text-zinc-200">{draft.title}</span>
        {/* M57: staged = コミット/Release作成はできたが**まだ非公開**。緑の「✓投稿済み」で
            出してしまうと、誰にも読まれていない記事を「出した」と勘違いし続ける(実際した) */}
        {draft.status === 'staged' && (
          <span className="text-[10px] text-amber-400" title="Zennは published:false、GitHub Releaseは draft。公開はあなたが押す">
            📤 公開待ち — まだ誰も読めない({draft.media === 'zenn' ? 'Zennで published: true に' : 'GitHubでPublish'})
          </span>
        )}
        {draft.status === 'posted' && (
          <>
            <span className="text-[10px] text-green-400">✓ 投稿済み({draft.postedAt?.slice(0, 10)})</span>
            {/* M44: Xは「開いた=投稿済み」にするが、Postを押さなかった場合はここで取り消す */}
            <button
              className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              title="実際には投稿しなかった場合に戻す(再び行き先ボタンが出る)"
              onClick={() => {
                void window.api
                  .operationsDraftUpdate(draft.id, { status: 'draft', media: undefined as never })
                  .then(onUpdate);
              }}
            >
              未投稿に戻す
            </button>
          </>
        )}
      </div>
      <pre className="mb-1 max-h-40 overflow-auto whitespace-pre-wrap text-zinc-300">{draft.body}</pre>
      <div className="flex flex-wrap items-center gap-1.5">
        <CopyButton text={draft.body} />
        {/* M32-9: 1タップ投稿リンク — 開いた先の投稿/追加ボタンは人間が押す(自動投稿はしない) */}
        {actions.includes('x-intent') && draft.status === 'draft' && (
          <button
            className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-[10px] hover:bg-zinc-800"
            title="X の投稿画面を本文入りで開く(投稿ボタンはあなたが押す)。開いた時点で投稿済みにする(二重送信防止。押さなかったら「未投稿に戻す」)"
            onClick={() => {
              void window.api.openExternal(xIntentUrl(draft.body));
              // M44: 開いた=投稿済み。残り続けると同じ文面を二度出す事故になる
              void window.api.operationsDraftUpdate(draft.id, { status: 'posted', media: 'x' }).then(onUpdate);
            }}
          >
            𝕏 投稿画面を開く
          </button>
        )}
        {actions.includes('hatena') && url !== null && (
          <button
            className="shrink-0 rounded border border-zinc-600 px-2 py-0.5 text-[10px] hover:bg-zinc-800"
            title="本文中のURLをはてなブックマークに追加する画面を開く(追加ボタンはあなたが押す)"
            onClick={() => void window.api.openExternal(hatenaPanelUrl(url))}
          >
            B! はてブ画面を開く
          </button>
        )}
        {actions.includes('github-release') && draft.status === 'draft' && <ReleaseAction draft={draft} />}
        {actions.includes('zenn-article') && draft.status === 'draft' && (
          <ZennArticleAction draft={draft} onUpdate={onUpdate} />
        )}
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
  // M84: 保存順(≒作成順)に頼らず、作成時刻で新しい順に並べる。上が最新
  const activeDrafts = drafts
    .filter((d) => d.status !== 'discarded')
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

      <Section title="AMENO-koyane" kana="アメノコヤネ" role="神々の時計 — 定刻ジョブと予算の司会進行">
        <GodClocks />
      </Section>

      <Section title="受け箱" kana="inbox" role="神々の成果物キュー">
        <InboxView />
      </Section>

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
        <ImpactView />
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
        {/* M73: 記事化(コミット)の先=公開。ここが無かったせいで記事が露出ゼロのまま埋もれた */}
        <ReleasePublishSection />
        <ZennPublishSection />

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
                {searchResult.hn.length > 0 && (
                  <div className="space-y-0.5">
                    <p className="text-[10px] text-zinc-500">Hacker News:</p>
                    {searchResult.hn.map((s) => (
                      <div key={s.id} className="text-[10px]">
                        <a
                          className="text-blue-400 hover:underline"
                          href={`https://news.ycombinator.com/item?id=${s.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {s.title}
                        </a>
                        <span className="ml-1 text-zinc-600">▲{s.points} 💬{s.numComments}</span>
                      </div>
                    ))}
                  </div>
                )}
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

      <Section title="KUE-biko" kana="クエビコ" role="要望の目利き(コア/UI要望のトリアージ)">
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
          disabled={busy !== null || !ghDetected}
          onClick={() => run('kuebiko', () => window.api.operationsGodRun('kuebiko'))}
        >
          {busy === 'kuebiko' ? '要望を拾い上げ中…' : '🪆 いま届いている要望を拾い上げる'}
        </button>
        <p className="text-xs text-zinc-500">
          配布版の利用者(と、その利用者のAMA-teras自身)が出した本体への要望
          (request:core / request:ui のIssue)を見張り、効き目の順に並べて
          <span className="text-zinc-300">神議の承認カード</span>へ載せる。承認すると本体(コア/UI)の進化ジョブになる
          ため、<span className="text-zinc-300">開発機でだけ</span>動く。結果は左の⛩運営スレッドに出る
        </p>
      </Section>
    </div>
  );
}
