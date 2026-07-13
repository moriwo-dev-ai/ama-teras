/**
 * M39: 運営の一括承認まわりの共有定数(main と renderer が同じ判断をするため)。
 * ロジックは置かない(判定の純関数のみ)。
 */

/**
 * リンクを開くところまでしかできない媒体(アプリからは何も発行しない)。
 * X は規約上、自動投稿・自動フォローを実装しない(アダプタの execute 宣言も空)。
 * はてブも同様に「追加画面を開く」まで。最後のクリックは必ず人間が押す。
 */
export const LINK_ONLY_ADAPTERS = ['x', 'hatena'] as const;

export function isLinkOnlyAdapter(adapterId: string): boolean {
  return (LINK_ONLY_ADAPTERS as readonly string[]).includes(adapterId);
}

/** 一度に開くブラウザウィンドウの上限。超えた分は「続きを開く」で人間が刻む */
export const MAX_LINKS_PER_OPEN = 5;

/** X Web Intent(投稿画面を本文プリセットで開く。投稿ボタンは人間が押す) */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/** はてなブックマーク追加パネル(追加ボタンは人間が押す) */
export function hatenaPanelUrl(url: string): string {
  return `https://b.hatena.ne.jp/entry/panel/?url=${encodeURIComponent(url)}`;
}

/**
 * M43-1: 発信テキストのプレースホルダ解決。
 * AMENO-uzume のプロンプトは「リンクは {URL} と書け」と指示するが、**置換する処理が
 * どこにも無かった**ため、X・Blueskyへ `{URL}` の文字列がそのまま投稿されていた(実害)。
 * URLが未設定なら、置換ではなく**プレースホルダごと落とす**(意味のない文字列を出さない)
 */
export function resolvePostText(body: string, projectUrl: string): string {
  const replaced =
    projectUrl === '' ? body.replace(/\s*\{URL\}\s*/g, ' ') : body.replace(/\{URL\}/g, projectUrl);
  return replaced.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * M43-1: 未解決のプレースホルダ(`{URL}` `{TAG}` 等)が残っていないか。
 * 発信の直前にこれを見て、残っていたら**実行しない**(テンプレートを外に出さないための最後の砦)
 */
export function hasUnresolvedPlaceholder(text: string): boolean {
  return /\{[A-Z][A-Z_]{1,}\}/.test(text);
}

/**
 * M49: **未公開機能の発信ガード**。
 *
 * 実害: 神(AMENO-uzume)が月読モード(未公開機能)の開発記を書き、承認バッチに載せ、
 * Zenn記事として**公開リポジトリに push された**(published:false でも、リポジトリが
 * PUBLIC なら GitHub 上でソースが読める)。カメラ・マイク・VAD・権限設計まで全部書かれていた。
 *
 * 神は「何が未公開か」を知らない。**知らせるのではなく、通さない** —
 * ドラフト生成の時点で捨て、承認バッチにも載せず、発信の直前でも弾く(三重)。
 */
const UNRELEASED_TOPICS = [
  '月読',
  'つくよみ',
  'ツクヨミ',
  'tsukuyomi',
  'tuku-yomi',
  'tsuku-yomi',
  '記憶の義手',
  '在席検知',
  '常時聴取',
  'push-to-talk',
  'whisper',
  'ウェイクワード',
  '月の帳',
];

/**
 * 未公開機能(TUKU-yomi)に触れている発信か。
 * 一般公開するまで、この語を含む下書きは**外に出さない**
 */
export function mentionsUnreleased(text: string): boolean {
  const t = text.toLowerCase();
  return UNRELEASED_TOPICS.some((w) => t.includes(w.toLowerCase()));
}

/** リポジトリ名(owner/repo)→ GitHubのURL。{URL} の既定の解決先 */
export function repoUrl(repo: string | undefined): string {
  return repo === undefined || repo.trim() === '' ? '' : `https://github.com/${repo.trim()}`;
}

/** 本文から最初の http(s) URL(はてブ対象の記事URL検出)。無ければ null */
export function firstUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]}、。]+/.exec(text);
  return m ? m[0] : null;
}

/**
 * アダプタid → 媒体名(下書きの media 欄・効果測定・戦略ボードで使う共通の呼び名)。
 * 'zenn-repo' は実装の都合の名前なので、媒体としては 'zenn' に寄せる
 */
export function mediaOf(adapterId: string): string {
  return adapterId === 'zenn-repo' ? 'zenn' : adapterId;
}

/**
 * M46: 次のバージョンを機械的に決める。人間が「前回いくつだったか」を覚えなくてよくする。
 * latest が無い(初回リリース)なら現在のアプリ版をそのまま使う。
 * 解釈できないタグ(nightly 等)は触らない = null を返し、UIは手入力に落とす
 */
export function nextVersion(latest: string | null, bump: 'patch' | 'minor' | 'major'): string | null {
  if (latest === null || latest.trim() === '') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(latest.trim());
  if (m === null) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const next =
    bump === 'major' ? [major + 1, 0, 0] : bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
  return `v${next.join('.')}`;
}

/** 'v1.2.3' と '1.2.3' を同じものとして比べる(package.json とタグの食い違い検出) */
export function sameVersion(a: string, b: string): boolean {
  const norm = (v: string): string => v.trim().replace(/^v/, '');
  return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * M44: この行き先へ出したら、下書きを「投稿済み」にしてよいか。
 * X は規約上リンクを開くまでしかできない(最後のPostは人間)が、**開いた時点で投稿済みにする**
 * — でないと下書きが残り続けて二重送信の元になる(UIから「未投稿に戻す」で取り消せる)。
 * はてブは同じ下書きの補助(ブックマーク)なので投稿済みにしない
 * (してしまうと、その下書きのX投稿が「済み」扱いで消える)
 */
export function marksDraftPosted(adapterId: string): boolean {
  return adapterId !== 'hatena';
}

/**
 * M57: **「出した」と「出す準備ができた」は違う**。
 *
 * 実害: Zenn記事は `published: false` でコミットされ、GitHub Release は draft で作られる。
 * どちらも**外からは誰も読めない**。にもかかわらずアプリは下書きを「投稿済み」として記録し、
 * 神議はそれを「発信した」と数え、「7/12だけでzenn5件・x4件を投下したのに反応が無い =
 * 物量>質が問題」と結論した。**実際に公開されていたZenn記事は1本だけ**だった。
 * 効果測定も、誰にも読まれていない記事の「効果」を測っていた。
 *
 * 反応が無いのは当たり前で、原因は物量でも質でもなく「**公開ボタンが押されていない**」。
 * 神に嘘のデータを与えると、神は嘘の結論を出す。
 *
 * - posted: 本当に外に出た(X・はてブ・Bluesky。最後のクリックが人間でも、出れば公開)
 * - staged: 出す準備までできたが**まだ非公開**(Zennの published:false、GitHubのdraft release)。
 *   公開するには人間がもう一手(Zenn管理画面 / GitHubのPublish)を打つ必要がある
 */
export function draftStatusAfter(adapterId: string): 'posted' | 'staged' {
  return adapterId === 'zenn-repo' || adapterId === 'github' ? 'staged' : 'posted';
}

/** staged = 準備できたが未公開。人間があと1手打つまで、誰にも読まれていない */
export function isStaged(status: string): boolean {
  return status === 'staged';
}

/**
 * もうこの下書きは外へ出す処理を通したか(二重投稿ガード用)。
 * staged も「出した」側 — 未公開でも**コミット済み・Release作成済み**なので、
 * もう一度通すと二重コミット・二重Releaseになる(M45で実際に起きた事故)
 */
export function alreadyOut(status: string): boolean {
  return status === 'posted' || status === 'staged';
}

/** 一括承認の単位キー(媒体×アクション)。異なる媒体・アクションは混ぜない */
export function bulkGroupKey(adapterId: string, actionName: string): string {
  return `${adapterId}:${actionName}`;
}

/** 一括実行の結果(1件ずつの成否。途中で失敗しても残りは続行する) */
export interface BulkItemResult {
  itemId: string;
  target: string;
  ok: boolean;
  detail: string;
}

export interface BulkRespondResult {
  ok: boolean;
  /** 例: 「3件中2件成功」 */
  detail: string;
  results: BulkItemResult[];
  /** リンク媒体(X/はてブ)のとき、renderer が開くURL。main は何も発行しない */
  links?: { itemId: string; label: string; url: string }[];
}
