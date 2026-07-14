import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalBatch,
  ApprovalBatchItem,
  CommunityCandidate,
  GodClockJob,
  ImpactEntry,
  InboxItem,
  IwatoRequestPayload,
  MetricsSnapshot,
  OperationsDraft,
  OpsThreadMessage,
  TriageCard,
} from '../../../shared/types';
import {
  bulkGroupKey,
  firstUrl,
  hatenaPanelUrl,
  isLinkOnlyAdapter,
  MAX_LINKS_PER_OPEN,
  xIntentUrl,
} from '../../../shared/operations';
import type { RemoteApi } from '../api';

/**
 * M34-6 / M40: リモートUIの「運営」タブ — 出先のスマホだけで運営が完結する。
 * M40でデスクトップの運営タブと同等の操作を持たせた:
 * ①岩戸ゲートの実行承認(全文) ②承認バッチ(1件ずつ+媒体×アクションの一括)
 * ③発信ドラフトの個別操作(X/はてブを開く・GitHub Release・Zenn記事化・投稿済み/破棄)
 * ④神々の時計の操作(稼働・間隔・予算・🔒解錠)と各神の「今すぐ実行」
 * ⑤効果測定・受け箱・⛩スレッド。
 * 外部への発信は従来どおり岩戸ゲート(スマホにも承認カードが出る)を必ず通る。
 * 設定(APIキー・接続先)の変更はPC側限定のまま。
 */

const GOD_LABEL: Record<string, string> = {
  'omoi-kami': '🧠 観測',
  'uzume-patrol': '💃 巡回',
  'uzume-drafts': '💃 下書き',
  'tedika-rao': '💪 門番',
  kamuhakari: '⛩ 神議',
};

const DRAFT_KIND_LABEL: Record<OperationsDraft['kind'], string> = {
  'x-post': 'X投稿',
  'release-note': 'リリースノート',
  'article-outline': '記事アウトライン',
  'article-body': 'Zenn記事本文',
  reply: '返信',
  'weekly-report': '週報',
};

const GROUP_LABEL: Record<string, string> = {
  'x:open-intent': '𝕏 X投稿画面',
  'hatena:add': 'B! はてブ追加画面',
  'bluesky:post': '🦋 Bluesky投稿',
  'bluesky:follow': '🦋 Blueskyフォロー',
  'github:release': '🐙 GitHub Release(下書き)',
  'zenn-repo:commit-article': '📝 Zenn記事(published: false)',
};

/** 投稿先の媒体(PC側と同じ7つ)。効果測定は media 別に集計されるので、空で記録させない */
const MEDIA_OPTIONS = ['x', 'zenn', 'hatena', 'hn', 'reddit', 'bluesky', 'github'];

/** 種類から素直に決まる既定の媒体(選び直せる) */
const DEFAULT_MEDIA: Record<OperationsDraft['kind'], string> = {
  'x-post': 'x',
  'article-outline': 'zenn',
  'article-body': 'zenn',
  'release-note': 'github',
  reply: 'github',
  'weekly-report': 'zenn',
};

/** 受け箱の種別アイコン(PC側には出ていて、スマホには無かった) */
const INBOX_ICON: Record<string, string> = {
  metrics: '📊',
  candidate: '🔮',
  triage: '💪',
  draft: '💃',
  evolution: '🧬',
  notice: '📣',
};

/** 差分は符号を付けないと「増えたのか減ったのか」が読めない */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

const totals = (s: MetricsSnapshot): { stars: number; liked: number; hatena: number; views: number; downloads: number } => ({
  stars: Object.values(s.github).reduce((a, m) => a + m.stars, 0),
  liked: Object.values(s.zenn).reduce((a, m) => a + m.liked, 0),
  hatena: s.hatena === undefined ? 0 : Object.values(s.hatena).reduce((a, c) => a + c, 0),
  views: Object.values(s.github).reduce((a, m) => a + (m.views ?? 0), 0),
  downloads: Object.values(s.github).reduce((a, m) => a + (m.downloads ?? 0), 0),
});

function diffTotals(cur: MetricsSnapshot, prev: MetricsSnapshot): ReturnType<typeof totals> {
  const c = totals(cur);
  const p = totals(prev);
  return { stars: c.stars - p.stars, liked: c.liked - p.liked, hatena: c.hatena - p.hatena, views: c.views - p.views, downloads: c.downloads - p.downloads };
}

/** 数字と前回比。0のときは差分を出さない(「動いていない」ことが一目で分かるように) */
function Metric({ label, value, delta }: { label: string; value: number; delta?: number }): JSX.Element {
  return (
    <span>
      {label} {value}
      {delta !== undefined && delta !== 0 && (
        <span style={{ color: delta > 0 ? 'var(--green)' : 'var(--red)', fontSize: 12 }}> {signed(delta)}</span>
      )}
    </span>
  );
}

/**
 * M55: 長文は既定で4行に畳む。以前は maxHeight + overflow:auto の枠内スクロールで、
 * ページを指でスクロールしている最中に枠へ入るとスクロールが吸われていた(スクロールトラップ)。
 * 神議の分析は長文で、1件で画面数枚ぶん流れる
 */
function LongText({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = text.length > 140;
  return (
    <div>
      <div className={long && !open ? 'longtext clamp' : 'longtext'}>{text}</div>
      {long && (
        <button className="morebtn" onClick={() => setOpen(!open)}>
          {open ? '畳む' : 'つづきを読む'}
        </button>
      )}
    </div>
  );
}

/**
 * M60: 下書きリリースの公開。**staged を実際に世に出す唯一の操作**で、これがスマホから
 * できないせいで Zenn2本・Release2件が誰にも読まれないまま埋もれていた
 * (神議も「公開作業の未実施がボトルネック」と診断した)。
 * 配布物(assets)が空のリリースは公開させない — 中身の無いリリースを世に出さないため
 */
function ReleasePublish({ repos, api, onDone }: { repos: string[]; api: RemoteApi; onDone: () => void }): JSX.Element {
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [info, setInfo] = useState<{ tag: string; assets: string[] } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (repo === '') return;
    void api
      .opsReleaseInfo(repo)
      .then((r) => setInfo(r.pendingDraft))
      .catch(() => setInfo(null));
  }, [api, repo]);

  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div className="row">
        <select value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      {info === null ? (
        <p className="muted" style={{ fontSize: 11 }}>公開待ちの下書きリリースは無い</p>
      ) : (
        <>
          <div style={{ fontSize: 12 }}>
            🐙 {info.tag}{' '}
            <span className="muted">
              ({info.assets.length > 0 ? `${info.assets.length}個の配布物` : '配布物なし'})
            </span>
          </div>
          <button
            className="publish"
            disabled={busy || info.assets.length === 0}
            title={info.assets.length === 0 ? '配布物が無いリリースは公開できない' : ''}
            onClick={() => {
              setBusy(true);
              void api
                .opsReleasePublish(repo, info.tag)
                .then((r) => setNotice(r.detail))
                .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
                .finally(() => {
                  setBusy(false);
                  onDone();
                });
            }}
          >
            {busy ? '…' : `⛩ ${info.tag} を公開する`}
          </button>
          <p className="muted" style={{ fontSize: 11 }}>
            押した瞬間に全利用者のアプリへ更新通知が飛ぶ。承認カードがこの画面に出る
          </p>
        </>
      )}
      {notice !== '' && <div className="muted" style={{ fontSize: 11 }}>{notice}</div>}
    </div>
  );
}

/**
 * M73: Zenn記事の公開。「記事化」は published: false でコミットするだけで、**そこから先が
 * 誰の手も届かないまま**だった(実際に記事2本が丸一日以上、露出ゼロで放置された)。
 * GitHub Release と同じ条件——岩戸ゲートで全文を読んで承認——で、公開まで通す。
 * 未公開機能(月読)に触れる記事は blocked として出し、押させない
 */
function ZennPublish({ api, onDone }: { api: RemoteApi; onDone: () => void }): JSX.Element | null {
  const [articles, setArticles] = useState<{ slug: string; title: string; blocked: string | null }[]>([]);
  // M77: published:true にしたのにZennが同期していない記事(投稿数の上限などで止まる)
  const [stuck, setStuck] = useState<{ slug: string; title: string }[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const reload = useCallback(() => {
    void api
      .opsZennPublishable()
      .then((r) => setArticles(r.articles))
      .catch(() => setArticles([]));
    void api
      .opsZennStuck()
      .then((r) => setStuck(r.articles))
      .catch(() => setStuck([]));
  }, [api]);
  useEffect(reload, [reload]);

  if (articles.length === 0 && stuck.length === 0) return null;

  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      {stuck.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            ⏳ published: true にしたが、Zennがまだ公開していない(= 誰も読めない)
          </div>
          {stuck.map((a) => (
            <div key={a.slug} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 12 }}>{a.title}</div>
              <button
                disabled={busy !== ''}
                onClick={() => {
                  setBusy(a.slug);
                  setNotice('');
                  void api
                    .opsZennRedeploy(a.slug)
                    .then((r) => setNotice(r.detail))
                    .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
                    .finally(() => {
                      setBusy('');
                      reload();
                      onDone();
                    });
                }}
              >
                {busy === a.slug ? '…' : '🔄 再デプロイ(Zennの同期をやり直す)'}
              </button>
            </div>
          ))}
        </div>
      )}
      {articles.length > 0 && (
      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
        📝 公開待ちのZenn記事(published: false = まだ誰も読めない)
      </div>
      )}
      {articles.map((a) => (
        <div key={a.slug} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 12 }}>{a.title}</div>
          {a.blocked !== null ? (
            <p className="muted" style={{ fontSize: 11 }}>🚫 {a.blocked}</p>
          ) : (
            <button
              className="publish"
              disabled={busy !== ''}
              onClick={() => {
                setBusy(a.slug);
                setNotice('');
                void api
                  .opsZennPublish(a.slug)
                  .then((r) => setNotice(r.detail))
                  .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
                  .finally(() => {
                    setBusy('');
                    void api.opsZennPublishable().then((r) => setArticles(r.articles)).catch(() => {});
                    onDone();
                  });
              }}
            >
              {busy === a.slug ? '…' : '⛩ この記事を公開する'}
            </button>
          )}
        </div>
      ))}
      <p className="muted" style={{ fontSize: 11 }}>
        公開すると誰でも読める状態になる。承認カード(全文)がこの画面に出る
      </p>
      {notice !== '' && <div className="muted" style={{ fontSize: 11 }}>{notice}</div>}
    </div>
  );
}

/**
 * M62: PC専用だった操作(仲間候補・トリアージ・週報)。
 * 出先で「見て・判断して・返す」が完結しないと、結局PCの前に戻るまで運営が止まる。
 * 外部への発信を伴うもの(返信の送信等)は従来どおり岩戸ゲート経由でしか出ない
 */
function ExtraOps({ api }: { api: RemoteApi }): JSX.Element {
  const [candidates, setCandidates] = useState<CommunityCandidate[]>([]);
  const [cards, setCards] = useState<TriageCard[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback((): void => {
    void api.opsCandidates().then((r) => setCandidates(r.candidates.filter((c) => c.status === 'new'))).catch(() => {});
  }, [api]);
  useEffect(load, [load]);

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0' }}>🔮 仲間候補({candidates.length})</div>
      {candidates.length === 0 && <p className="muted" style={{ fontSize: 12 }}>候補なし(巡回が動いていない可能性もある — 受け箱を見る)</p>}
      {candidates.slice(0, 5).map((c) => (
        <div key={c.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{c.profile.slice(0, 60)}</div>
          <LongText text={c.reasons.join(' / ')} />
          <div className="row">
            <button
              className="reject"
              onClick={() => void api.opsCandidateResolve(c.id, 'discarded').then(load)}
            >
              破棄
            </button>
            <button className="primary" onClick={() => void api.opsCandidateResolve(c.id, 'kept').then(load)}>
              残す
            </button>
          </div>
        </div>
      ))}

      <div style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 4px' }}>💪 Issue/PR トリアージ</div>
      <button
        disabled={busy !== ''}
        onClick={() => {
          setBusy('triage');
          void api
            .opsTriage()
            .then((r) => {
              setCards(r.cards);
              if (r.cards.length === 0) setNotice('新着のIssue/PRは無い');
            })
            .catch((e: unknown) => setNotice(String(e)))
            .finally(() => setBusy(''));
        }}
      >
        {busy === 'triage' ? '確認中…' : '新着を確認'}
      </button>
      {cards.map((c) => (
        <div key={c.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {c.kind === 'pr' ? '🔀' : '🐛'} {c.repo}#{c.number} {c.title}
          </div>
          <LongText text={c.summary} />
          {c.recommendation !== '' && (
            <div className="muted" style={{ fontSize: 11 }}>推奨: {c.recommendation}</div>
          )}
        </div>
      ))}

      <div style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 4px' }}>📝 週報</div>
      <button
        disabled={busy !== ''}
        onClick={() => {
          setBusy('weekly');
          void api
            .opsWeeklyReport()
            .then((r) => setNotice(r.draft === null ? '生成できなかった' : `週報を下書きに追加した: ${r.draft.title}`))
            .catch((e: unknown) => setNotice(String(e)))
            .finally(() => setBusy(''));
        }}
      >
        {busy === 'weekly' ? '生成中…' : '週報を生成'}
      </button>
      {notice !== '' && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{notice}</div>}
    </div>
  );
}

function IwatoCard({ req, api, onDone }: { req: IwatoRequestPayload; api: RemoteApi; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const respond = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.opsIwatoRespond(req.id, approved);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h3>⛩ 外部への発信: {req.adapterId} / {req.action}</h3>
      <div className="warn-banner">この操作はアプリの外(公開の場)に発信されます</div>
      <div className="muted" style={{ fontSize: 12 }}>どこへ: {req.target}</div>
      <LongText text={req.preview} />
      <div className="muted" style={{ fontSize: 11 }}>📜 {req.compliance}</div>
      {error && <div className="error-banner">{error}</div>}
      <div className="row">
        {/* M55: 「拒否」と「発信を承認」が同じ見た目だった(.primary はCSSに存在すらしなかった)。
            外へ出る不可逆な操作だけは警告色にして、押す前に一拍置かせる */}
        <button className="reject" disabled={busy} onClick={() => void respond(false)}>
          拒否
        </button>
        <button className="publish" disabled={busy} onClick={() => void respond(true)}>
          ⛩ 発信を承認
        </button>
      </div>
    </div>
  );
}

/** M40: 一括バー(媒体×アクション)。X/はてブは links を受け取ってスマホのブラウザで開く */
function BulkBar({
  batchId,
  groupKey,
  items,
  api,
  onDone,
  onLinks,
}: {
  batchId: string;
  groupKey: string;
  items: ApprovalBatchItem[];
  api: RemoteApi;
  onDone: () => void;
  // M74: リンクはカードの外(LinkTray)へ。承認するとこのバーごと消えるため
  onLinks: (links: { itemId: string; label: string; url: string }[]) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [links, setLinks] = useState<{ itemId: string; label: string; url: string }[]>([]);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const linkOnly = isLinkOnlyAdapter(items[0]?.action?.adapterId ?? '');

  return (
    <div style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>
        {GROUP_LABEL[groupKey] ?? groupKey} {items.length}件
      </div>
      <div className="row">
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .opsBulkRespond(batchId, items.map((i) => i.id), false)
              .then((r) => setNotice(r.detail))
              .finally(() => {
                setBusy(false);
                onDone();
              });
          }}
        >
          まとめて却下
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNotice('');
            void api
              .opsBulkRespond(batchId, items.map((i) => i.id), true)
              .then((r) => {
                setNotice(r.detail);
                // M41-2: スマホのブラウザは「タップした瞬間」以外の window.open を塞ぐ。
                // 承認(通信)のあとに自動で開こうとすると必ずブロックされるので、
                // 開くボタンを並べて1枚ずつタップしてもらう(タップ=ジェスチャ)
                setLinks(r.links ?? []);
                onLinks(r.links ?? []);
              })
              .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                setBusy(false);
                onDone();
              });
          }}
        >
          {busy ? '…' : linkOnly ? `${items.length}件を承認して開く` : `⛩ ${items.length}件まとめて承認`}
        </button>
      </div>
      {links.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div className="muted" style={{ fontSize: 11 }}>
            タップで1枚ずつ開く(投稿ボタンはあなたが押す)。{opened.size}/{links.length} 開封済み
          </div>
          {/* M55: 以前は「1/5 を開く」で、どの投稿を開くのか判別できなかった。
              一度に開くのは MAX_LINKS_PER_OPEN 件まで(PC側と同じ。開きすぎて迷子にならない) */}
          {links.slice(0, showAll ? links.length : MAX_LINKS_PER_OPEN).map((l) => (
            <button
              key={l.itemId}
              style={{ display: 'block', width: '100%', marginTop: 4, textAlign: 'left' }}
              onClick={() => {
                window.open(l.url, '_blank', 'noopener,noreferrer');
                setOpened(new Set([...opened, l.itemId]));
              }}
            >
              {opened.has(l.itemId) ? '✓ ' : '↗ '}
              {l.label}
            </button>
          ))}
          {!showAll && links.length > MAX_LINKS_PER_OPEN && (
            <button className="morebtn" onClick={() => setShowAll(true)}>
              残り{links.length - MAX_LINKS_PER_OPEN}件を表示
            </button>
          )}
        </div>
      )}
      {notice !== '' && <div className="muted" style={{ fontSize: 11 }}>{notice}</div>}
    </div>
  );
}

/**
 * M74: 承認して受け取ったリンク(X/はてブ)を**カードの外**に置く。
 * 以前はリンクを承認したカード自身の中に出していたが、承認した瞬間その項目は pending から
 * 外れ、`pending.length === 0` でカードごと消える → **リンクボタンは一瞬も表示されなかった**。
 * 「Xの投稿ボタンを押したのにXが立ち上がらない」の正体。開き終えるまでここに残す
 */
function LinkTray({
  links,
  onClear,
}: {
  links: { itemId: string; label: string; url: string }[];
  onClear: () => void;
}): JSX.Element | null {
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  if (links.length === 0) return null;
  return (
    <div className="card">
      <h3>↗ 開いて投稿する({opened.size}/{links.length})</h3>
      <div className="muted" style={{ fontSize: 11 }}>
        承認済み。タップで1枚ずつ開く(**投稿ボタンはあなたが押す**)。スマホはタップ以外の
        window.open を塞ぐので、自動では開けない
      </div>
      {links.slice(0, showAll ? links.length : MAX_LINKS_PER_OPEN).map((l) => (
        <button
          key={l.itemId}
          style={{ display: 'block', width: '100%', marginTop: 4, textAlign: 'left' }}
          onClick={() => {
            window.open(l.url, '_blank', 'noopener,noreferrer');
            setOpened(new Set([...opened, l.itemId]));
          }}
        >
          {opened.has(l.itemId) ? '✓ ' : '↗ '}
          {l.label}
        </button>
      ))}
      {!showAll && links.length > MAX_LINKS_PER_OPEN && (
        <button className="morebtn" onClick={() => setShowAll(true)}>
          残り{links.length - MAX_LINKS_PER_OPEN}件を表示
        </button>
      )}
      <button className="morebtn" onClick={onClear}>
        閉じる
      </button>
    </div>
  );
}

function BatchCard({
  batch,
  api,
  onDone,
  onLinks,
}: {
  batch: ApprovalBatch;
  api: RemoteApi;
  onDone: () => void;
  onLinks: (links: { itemId: string; label: string; url: string }[]) => void;
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [links, setLinks] = useState<{ itemId: string; label: string; url: string }[]>([]);
  const pending = batch.items.filter((i) => i.status === 'pending');
  if (pending.length === 0) return <></>;

  // M39: 同種(媒体×アクション)を束ねる。2件以上あるグループだけ一括バーを出す
  const groups = new Map<string, ApprovalBatchItem[]>();
  for (const item of pending) {
    if (item.action === undefined) continue;
    const key = bulkGroupKey(item.action.adapterId, item.action.actionName);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const respondOne = (item: ApprovalBatchItem, approved: boolean): void => {
    setBusy(item.id);
    const p =
      item.action !== undefined
        ? api.opsBulkRespond(batch.id, [item.id], approved).then((r) => {
            // M41-2: 自動で開かない(スマホはポップアップを塞ぐ)。開くボタンを出す
            // M74: カードの外(LinkTray)に出す。承認した瞬間このカードは消えるため
            setLinks(r.links ?? []);
            onLinks(r.links ?? []);
            return r;
          })
        : api.opsBatchRespond(batch.id, item.id, approved);
    void p
      .then((r) => setNotice(r.detail))
      .finally(() => {
        setBusy(null);
        onDone();
      });
  };

  return (
    <div className="card">
      <h3>⛩ 神議の承認バッチ({batch.ts.slice(5, 16)})</h3>
      <LongText text={batch.analysis} />
      {[...groups.entries()]
        .filter(([, items]) => items.length >= 2)
        .map(([key, items]) => (
          <BulkBar key={key} batchId={batch.id} groupKey={key} items={items} api={api} onDone={onDone} onLinks={onLinks} />
        ))}
      {pending.map((item) => (
        <div key={item.id} style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{item.title}</div>
          <LongText text={item.detail} />
          {item.action !== undefined && <LongText text={item.action.preview} />}
          <div className="row">
            <button disabled={busy !== null} onClick={() => respondOne(item, false)}>却下</button>
            <button disabled={busy !== null} className="primary" onClick={() => respondOne(item, true)}>
              承認
            </button>
          </div>
        </div>
      ))}
      {links.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div className="muted" style={{ fontSize: 11 }}>タップで開く(投稿ボタンはあなたが押す)</div>
          {links.map((l) => (
            <button
              key={l.itemId}
              style={{ marginRight: 6, marginTop: 4 }}
              onClick={() => window.open(l.url, '_blank', 'noopener,noreferrer')}
            >
              {l.label.slice(0, 24)} を開く
            </button>
          ))}
        </div>
      )}
      {notice !== '' && <div className="muted" style={{ fontSize: 11 }}>{notice}</div>}
    </div>
  );
}

/** M40: 発信ドラフト1枚。デスクトップの DraftCard 相当(行き先は種類ごとに固定) */
function DraftCard({
  draft,
  repos,
  api,
  onDone,
}: {
  draft: OperationsDraft;
  repos: string[];
  api: RemoteApi;
  onDone: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [tag, setTag] = useState(/v\d+\.\d+\.\d+/.exec(draft.body)?.[0] ?? '');
  const [repo, setRepo] = useState(repos[0] ?? '');
  // M82: リリースノートの本文にバージョンが書かれていないと、スマホでは版を採番する手段が
  // 無く「Releaseへ」が押せないままだった(PCは releaseInfo の候補を出している)。
  // 同じ一次情報(最新タグ)から次の版を採番して初期値に入れる。手入力でも上書きできる
  const [tagHint, setTagHint] = useState('');
  useEffect(() => {
    if (draft.kind !== 'release-note' || repo === '' || tag !== '') return;
    void api
      .opsReleaseInfo(repo)
      .then((info) => {
        const next = info.suggestions.patch ?? (info.appVersion === '' ? '' : `v${info.appVersion}`);
        if (next !== '') setTag(next);
        setTagHint(info.latestTag === null ? '最新リリースなし' : `最新 ${info.latestTag}`);
      })
      .catch(() => setTagHint(''));
  }, [draft.kind, repo, tag, api]);
  const [media, setMedia] = useState(draft.media ?? DEFAULT_MEDIA[draft.kind]);
  const url = firstUrl(draft.body);

  const run = (label: string, p: Promise<{ ok: boolean; detail: string }>): void => {
    setBusy(true);
    setNotice(`${label}…`);
    void p
      .then((r) => setNotice(r.detail))
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        onDone();
      });
  };

  return (
    <div style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 8 }}>
      <div style={{ fontSize: 12 }}>
        <span className="muted">[{DRAFT_KIND_LABEL[draft.kind]}]</span> <b>{draft.title}</b>
      </div>
      <LongText text={draft.body} />
      <div className="row">
        <button onClick={() => void navigator.clipboard.writeText(draft.body).then(() => setNotice('コピーした'))}>
          コピー
        </button>
        {draft.kind === 'x-post' && draft.status === 'draft' && (
          <button
            onClick={() => {
              // M44: 開いた=投稿済み(二重送信防止)。タップと同じ同期処理内で開くこと
              // (await の後だとポップアップブロックに塞がれる)
              window.open(xIntentUrl(draft.body), '_blank', 'noopener,noreferrer');
              void api.opsDraftUpdate(draft.id, { status: 'posted', media: 'x' }).then(() => onDone());
            }}
          >
            𝕏 投稿画面
          </button>
        )}
        {draft.kind === 'x-post' && url !== null && (
          <button onClick={() => window.open(hatenaPanelUrl(url), '_blank', 'noopener,noreferrer')}>B! はてブ</button>
        )}
        {draft.status === 'posted' && (
          <button onClick={() => void api.opsDraftUpdate(draft.id, { status: 'draft' }).then(() => onDone())}>
            未投稿に戻す
          </button>
        )}
        {draft.kind === 'article-outline' && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => run('本文を執筆中', api.opsDraftZenn(draft.id))}
          >
            📝 Zenn記事化
          </button>
        )}
      </div>
      {draft.kind === 'release-note' && (
        <div className="row">
          <select value={repo} onChange={(e) => setRepo(e.target.value)} style={{ minWidth: 0, flex: 1 }}>
            {repos.length === 0 && <option value="">(リポジトリ未設定)</option>}
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            style={{ width: 90 }}
            placeholder="v1.0.1"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            title={tagHint}
          />
          <button
            className="primary"
            disabled={busy || repo === '' || tag.trim() === ''}
            onClick={() => run('承認待ち', api.opsDraftRelease(draft.id, repo, tag.trim()))}
          >
            🐙 Releaseへ
          </button>
        </div>
      )}
      {draft.kind === 'release-note' && tagHint !== '' && (
        <div className="muted" style={{ fontSize: 11 }}>
          {tagHint} → 次の版を自動で入れた(直せます)
        </div>
      )}
      {draft.status === 'draft' && (
        <div className="row">
          {/* M55: 媒体を送っていなかった。APIは元から受け付けるのに、スマホから投稿済みにすると
              media が空のまま記録され、効果測定の媒体別集計が壊れていた */}
          <select value={media} onChange={(e) => setMedia(e.target.value)} style={{ maxWidth: 110 }}>
            {MEDIA_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api
                .opsDraftUpdate(draft.id, { status: 'posted', media })
                .finally(() => {
                  setBusy(false);
                  onDone();
                });
            }}
          >
            投稿済みにする
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api.opsDraftUpdate(draft.id, { status: 'discarded' }).finally(() => {
                setBusy(false);
                onDone();
              });
            }}
          >
            破棄
          </button>
        </div>
      )}
      {notice !== '' && <div className="muted" style={{ fontSize: 11 }}>{notice}</div>}
    </div>
  );
}

/** M40: 神々の時計(AMENO-koyane)。稼働・間隔・予算・🔒解錠・今すぐ実行 */
function ClockRow({ job, api, onDone }: { job: GodClockJob; api: RemoteApi; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const patch = (p: Parameters<RemoteApi['opsClockUpdate']>[1]): void => {
    setBusy(true);
    void api.opsClockUpdate(job.id, p).finally(() => {
      setBusy(false);
      onDone();
    });
  };
  return (
    <div style={{ borderTop: '1px solid #333', paddingTop: 6, marginTop: 6 }}>
      <div style={{ fontSize: 12 }}>
        {job.enabled ? '●' : '○'} <b>{GOD_LABEL[job.godId] ?? job.godId}</b>{' '}
        <span className="muted">
          {job.dailyTimes !== undefined ? `毎日${job.dailyTimes.join('/')}` : `${job.intervalMin}分毎`}
          {job.nextRun !== undefined ? ` 次${job.nextRun.slice(11, 16)}` : ''} 今日
          {job.spentToday.toLocaleString()}tok
        </span>
      </div>
      <div className="row">
        <button disabled={busy} onClick={() => patch({ enabled: !job.enabled })}>
          {job.enabled ? '停止' : '稼働'}
        </button>
        <input
          type="number"
          min={0}
          step={1000}
          style={{ width: 90 }}
          defaultValue={job.dailyTokenBudget}
          key={`${job.id}:${job.dailyTokenBudget}`}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0 && v !== job.dailyTokenBudget) patch({ dailyTokenBudget: v });
          }}
        />
        <button
          disabled={busy || job.budgetSetByUser !== true}
          title={
            job.budgetSetByUser === true
              ? '🔒 あなたの設定が優先中。押すと解錠して神議に調整権限を返す'
              : '🔓 神議が予算を調整できる状態'
          }
          onClick={() => patch({ budgetSetByUser: false })}
        >
          {job.budgetSetByUser === true ? '🔒' : '🔓'}
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNotice('実行中…');
            void api
              .opsGodRun(job.godId)
              .then((r) => setNotice(`${r.ok ? '✓' : '✗'} ${r.detail}`))
              .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                setBusy(false);
                onDone();
              });
          }}
        >
          今すぐ実行
        </button>
      </div>
      {notice !== '' && <div className="muted" style={{ fontSize: 11 }}>{notice}</div>}
    </div>
  );
}

export function OpsView({ api }: { api: RemoteApi }): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [clocks, setClocks] = useState<GodClockJob[]>([]);
  const [inbox, setInbox] = useState<(InboxItem & { read: boolean })[]>([]);
  const [latest, setLatest] = useState<MetricsSnapshot | null>(null);
  // M60: 前回のスナップショット(前回比のため)。合計値だけでは動いているかが読めない
  const [prev, setPrev] = useState<MetricsSnapshot | null>(null);
  const [iwato, setIwato] = useState<IwatoRequestPayload[]>([]);
  // M74: 承認で受け取ったリンクは、承認したカードが消えても残す(消えるせいでXが開けなかった)
  const [openLinks, setOpenLinks] = useState<{ itemId: string; label: string; url: string }[]>([]);
  const [batches, setBatches] = useState<ApprovalBatch[]>([]);
  const [messages, setMessages] = useState<OpsThreadMessage[]>([]);
  const [drafts, setDrafts] = useState<OperationsDraft[]>([]);
  const [impacts, setImpacts] = useState<ImpactEntry[]>([]);
  const [repos, setRepos] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const send = (): void => {
    setSending(true);
    void api
      .opsThreadSend(input.trim())
      .then((t) => {
        setMessages(t.messages);
        setInput('');
      })
      .finally(() => setSending(false));
  };

  const reload = useCallback((): void => {
    void api
      .opsSummary()
      .then((s) => {
        setEnabled(s.enabled);
        setClocks(s.clocks);
        setInbox(s.inbox);
        setLatest(s.latest);
        setIwato(s.pendingIwato);
      })
      .catch(() => setEnabled(false));
    void api.opsBatches().then((b) => setBatches(b.batches)).catch(() => {});
    void api.opsThread().then((t) => setMessages(t.messages)).catch(() => {});
    // M60: 直近2点あれば前回比が出せる。history は**古い順**に返す(slice(-limit))ので、
    // 2件なら [前回, 最新]。index 0 が前回
    void api
      .opsHistory(2)
      .then((h) => setPrev(h.snapshots.length >= 2 ? (h.snapshots[0] ?? null) : null))
      .catch(() => setPrev(null));
    void api
      .opsDrafts()
      .then((d) => {
        setDrafts(d.drafts);
        setImpacts(d.impacts);
        setRepos(d.repos);
      })
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    reload();
    // 岩戸の承認カードを取りこぼさないよう、承認待ちがある間は短い間隔で追う
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  // M55: 新しい発言が来たら最下部へ(PC側は元からやっている)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (enabled === null) return <p className="muted">読込中…</p>;
  if (!enabled) return <p className="muted">オーナーモードがOFF(デスクトップの設定→接続で有効化)</p>;

  const stars = latest ? Object.values(latest.github).reduce((a, m) => a + m.stars, 0) : null;
  const liked = latest ? Object.values(latest.zenn).reduce((a, m) => a + m.liked, 0) : null;
  const hatena = latest?.hatena !== undefined ? Object.values(latest.hatena).reduce((a, c) => a + c, 0) : null;
  const views = latest ? Object.values(latest.github).reduce((a, m) => a + (m.views ?? 0), 0) : null;
  const downloads = latest ? Object.values(latest.github).reduce((a, m) => a + (m.downloads ?? 0), 0) : null;
  const delta = latest !== null && prev !== null ? diffTotals(latest, prev) : null;
  const activeDrafts = drafts.filter((d) => d.status === 'draft');
  // M55: 投稿済みも出す。以前は status==='draft' だけを描いていたため、
  // 「未投稿に戻す」ボタンが**永久に描画されず**、X投稿画面を開いて(=posted化)から
  // 投稿を取りやめても、スマホからは取り消せなかった
  const postedDrafts = drafts.filter((d) => d.status === 'posted');
  // M57: 公開待ち = Zennに published:false でコミット済み / GitHub Release が draft のまま。
  // **誰にも読まれていない**。人間があと1手打つまで、この記事は存在しないのと同じ
  const stagedDrafts = drafts.filter((d) => d.status === 'staged');

  return (
    // M55: OpsView だけ .content を付け忘れていた。他のタブは全て付いている。
    // 結果、左右パディングが消え、内部スクロールコンテナが無いため
    // **タブバーごと画面外へスクロールアウト**していた(タブを切り替えるのに全画面戻る必要があった)
    <div className="content ops">
      {/* 承認待ち(最優先で上に。畳まない) */}
      {iwato.map((req) => (
        <IwatoCard key={req.id} req={req} api={api} onDone={reload} />
      ))}
      {/* M74: 承認済みの「開くリンク」。カードが消えても残る場所に置く */}
      <LinkTray links={openLinks} onClear={() => setOpenLinks([])} />
      {batches.map((b) => (
        <BatchCard
          key={b.id}
          batch={b}
          api={api}
          onDone={reload}
          onLinks={(l) => setOpenLinks((prev) => [...prev.filter((p) => !l.some((x) => x.itemId === p.itemId)), ...l])}
        />
      ))}

      {/* 主要数字 */}
      <div className="card">
        <h3>📊 いまの数字</h3>
        {/* M60: 合計値だけでは「動いているのか止まっているのか」が読めない。
            PCは前回比を出している。スマホにも同じものを出す */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 14 }}>
          {stars !== null && <Metric label="★" value={stars} delta={delta?.stars} />}
          {liked !== null && <Metric label="Zenn♥" value={liked} delta={delta?.liked} />}
          {hatena !== null && <Metric label="B!" value={hatena} delta={delta?.hatena} />}
          {views !== null && <Metric label="閲覧" value={views} delta={delta?.views} />}
          {downloads !== null && <Metric label="DL" value={downloads} delta={delta?.downloads} />}
        </div>
        {latest !== null && (
          <div className="muted" style={{ fontSize: 11 }}>
            観測: {latest.ts.slice(5, 16)}
            {prev !== null && ` (前回 ${prev.ts.slice(5, 16)} との差)`}
          </div>
        )}
        {impacts.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>発信の効果(前後差分)</div>
            {/* M55: 媒体・投稿先・B!・DL の差分は API に既に載っていたのに、★と♥しか描いていなかった */}
            {impacts.slice(0, 5).map((e) => (
              <div key={e.draftId} style={{ fontSize: 11, margin: '4px 0' }}>
                <div className="muted">
                  {e.postedAt.slice(5, 16)} {e.media !== null && `[${e.media}] `}
                  {e.url !== null ? (
                    <a href={e.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)' }}>
                      {e.title}
                    </a>
                  ) : (
                    e.title
                  )}
                </div>
                <div style={{ paddingLeft: 8 }}>
                  {e.measurable && e.delta !== null ? (
                    <span>
                      ★{signed(e.delta.stars)} / ♥{signed(e.delta.zennLiked)} / B!{signed(e.delta.hatena)} / DL
                      {signed(e.delta.downloads)} / 閲覧{signed(e.delta.views)}
                      <span className="muted"> ({e.windowHours}h窓)</span>
                    </span>
                  ) : (
                    <span className="muted">{e.note}</span>
                  )}
                </div>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 10 }}>※相関であって因果ではない</div>
          </div>
        )}
      </div>

      {/* M57: 公開待ち。放置すると「発信したのに反応が無い」と誤解し続けることになるので、
          ドラフトより上に、畳まずに出す */}
      {stagedDrafts.length > 0 && (
        <div className="card">
          <h3>📤 公開待ち({stagedDrafts.length})— まだ誰も読めない</h3>
          <div className="warn-banner">
            Zenn記事は published: false、GitHub Release は draft で作られる。あなたが公開ボタンを押すまで外からは読めない
          </div>
          {stagedDrafts.map((d) => (
            <div key={d.id} style={{ fontSize: 12, margin: '6px 0' }}>
              <span className="muted">[{d.media ?? '?'}]</span> {d.title}
              <div className="muted" style={{ fontSize: 11 }}>
                {d.media === 'zenn' ? 'Zennの記事管理で published: true にする(スマホからは公開できない)' : '↓ ここから公開できる'}
              </div>
            </div>
          ))}
          {/* M60/M73: GitHub Release も Zenn 記事も、スマホから公開できる(岩戸ゲートで全文確認) */}
          <ReleasePublish repos={repos} api={api} onDone={reload} />
          <ZennPublish api={api} onDone={reload} />
        </div>
      )}

      {/* 発信ドラフト(1枚ずつ操作)。未処理があるときは開いた状態で始める */}
      <details open={activeDrafts.length > 0}>
        <summary>
          💃 発信ドラフト <span className="count">未処理{activeDrafts.length} / 投稿済み{postedDrafts.length}</span>
        </summary>
        <div className="body">
          {activeDrafts.length === 0 && <p className="muted">未処理の下書きは無い</p>}
          {activeDrafts.map((d) => (
            <DraftCard key={d.id} draft={d} repos={repos} api={api} onDone={reload} />
          ))}
          {postedDrafts.length > 0 && (
            <details>
              <summary>
                投稿済み <span className="count">{postedDrafts.length}件(取り消しはここから)</span>
              </summary>
              <div className="body">
                {postedDrafts.slice(0, 10).map((d) => (
                  <DraftCard key={d.id} draft={d} repos={repos} api={api} onDone={reload} />
                ))}
              </div>
            </details>
          )}
          <div className="muted" style={{ fontSize: 11 }}>
            X/はてブは投稿画面を開くまで(投稿ボタンはあなたが押す)。Zenn/GitHubは岩戸ゲートの承認後に発行
          </div>
        </div>
      </details>

      {/* AMENO-koyane: 神々の時計(操作つき) */}
      <details>
        <summary>
          🕐 AMENO-koyane(神々の時計) <span className="count">{clocks.filter((c) => c.enabled).length}/{clocks.length} 稼働</span>
        </summary>
        <div className="body">
          {clocks.map((j) => (
            <ClockRow key={j.id} job={j} api={api} onDone={reload} />
          ))}
          <div className="muted" style={{ fontSize: 11 }}>
            予算0=無制限。🔒はあなたの設定が神議より優先。APIキー等の設定変更はPC側から
          </div>
        </div>
      </details>

      {/* M62: PC専用だったもの。出先で「見て・判断して・返す」が完結しないと、
          結局PCの前に戻るまで運営が止まる */}
      <details>
        <summary>
          🔮 仲間候補・💪 Issue/PR・📝 週報 <span className="count">PC専用だったもの</span>
        </summary>
        <div className="body">
          <ExtraOps api={api} />
        </div>
      </details>

      {/* 受け箱 */}
      <details>
        <summary>
          📥 受け箱 <span className="count">未読{inbox.filter((i) => !i.read).length}</span>
        </summary>
        <div className="body">
          {inbox.length === 0 && <p className="muted">空</p>}
          {inbox.slice(0, 15).map((i) => (
            <div key={i.id} style={{ fontSize: 12, opacity: i.read ? 0.5 : 1, margin: '4px 0' }}>
              {INBOX_ICON[i.kind] ?? '•'} <span className="muted">{i.ts.slice(5, 16)}</span> {i.title}
            </div>
          ))}
        </div>
      </details>

      {/* ⛩スレッド。入力欄はカード内に貼り付ける(以前は最下部にあり、一言送るのに全画面スクロールしていた) */}
      <div className="card">
        <h3>⛩ 運営スレッド</h3>
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {messages.slice(-20).map((m) => (
            <div key={m.id} style={{ marginBottom: 6, fontSize: 13 }}>
              <span className="muted" style={{ fontSize: 11 }}>
                {m.role === 'user' ? 'あなた' : m.role === 'kamuhakari' ? '🧠 神議' : '⚙'} {m.ts.slice(5, 16)}
              </span>
              <LongText text={m.body} />
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="thread-composer">
          <input
            placeholder="神議への相談・指示"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && input.trim() !== '' && !sending) send();
            }}
          />
          <button disabled={sending || input.trim() === ''} className="primary" onClick={send}>
            {sending ? '…' : '送信'}
          </button>
        </div>
      </div>
    </div>
  );
}
