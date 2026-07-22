import { readFile } from 'node:fs/promises';
import type { AdapterRuntime } from '../protocol';
import type { FetchLike } from './zenn';

/**
 * M32-2: blueskyアダプタ(骨組み)。公開AppView APIの read/search のみ。
 * 設計上はAT Protocolの自動化に寛容で承認後の投稿・フォローも許容範囲だが、
 * 認証(アプリパスワード保管)未実装のため execute は空 = 提案のみ。
 * 【M32判断】宣言と実挙動の一致を守るため「executeを宣言して未実装エラー」ではなく
 * 「宣言自体を空」にした。投稿対応時に capabilities と executor を同時に足すこと。
 */

export interface BlueskyPost {
  author: string;
  handle: string;
  text: string;
  uri: string;
}

export class BlueskyReader {
  constructor(
    /**
     * M72: 既定が `(url) => fetch(url)` で **init(=headers)を捨てていた**。
     * 実アプリは fetchImpl を注入していないためこの既定が使われ、認証トークンは取れているのに
     * Authorization ヘッダが乗らないまま bsky.social へ飛び、検索だけが 401。
     * それを「app passwordが失効している」と誤診し、ユーザーに再発行をお願いしていた(濡れ衣)
     */
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /**
     * M58: 検索用のアクセストークン(app passwordでログインして得る)。
     * Blueskyの公開検索APIは**認証必須になり、無認証は全クエリ403**を返すようになった
     */
    private readonly accessToken?: () => Promise<string | null>,
  ) {}

  /**
   * 投稿検索。
   *
   * M58: 以前は「公開検索API(認証不要)。不達は空配列」だった。ところが Bluesky は
   * 無認証の検索を止めており、**全クエリが403**。`if (!res.ok) return []` が
   * それを握りつぶし、巡回の神(AMENO-uzume)は「巡回完了(評価0/候補0)」と
   * **成功を報告し続けていた**。動いていない神が、動いているように見えていた。
   *
   * 不達は空配列ではなく**例外**にする。仕事ができない神は、できないと言わなければならない。
   */
  async searchPosts(query: string, limit = 10): Promise<BlueskyPost[]> {
    const token = this.accessToken === undefined ? null : await this.accessToken().catch(() => null);
    // 認証があるときは**自分のPDS**へ投げる(PDSがAppViewへ代理する)。
    // app password のトークンは公開AppView(public.api.bsky.app)では受け付けられない
    const host = token === null ? 'https://public.api.bsky.app' : 'https://bsky.social';
    const url = `${host}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await this.fetchImpl(url, {
      headers:
        token === null
          ? {}
          : {
              authorization: `Bearer ${token}`,
              // PDSは app.bsky.* を自分では処理しない。AppViewへ代理させる宛先を明示する
              // (これが無いと 401。認証は通っているのに検索だけ弾かれる、で30分溶かした)
              'atproto-proxy': 'did:web:api.bsky.app#bsky_appview',
            },
    });
    if (!res.ok) {
      // 「資格情報が無い」と「認証したのに拒否された」は原因も対処も違う。混ぜない
      const auth = res.status === 401 || res.status === 403;
      throw new Error(
        !auth
          ? `Bluesky検索に失敗(HTTP ${res.status})`
          : token === null
            ? 'Bluesky検索は認証必須になった。設定→接続でBlueskyのapp passwordを登録すると巡回できる'
            : `Blueskyに認証したが検索を拒否された(HTTP ${res.status})。app passwordが失効している可能性がある(Bluesky設定で作り直す)`,
      );
    }
    const data = (await res.json()) as Record<string, unknown>;
    const posts = data['posts'];
    if (!Array.isArray(posts)) return [];
    return posts.map((p) => {
      const rec = p as Record<string, unknown>;
      const author = (rec['author'] ?? {}) as Record<string, unknown>;
      const record = (rec['record'] ?? {}) as Record<string, unknown>;
      return {
        author: String(author['displayName'] ?? ''),
        handle: String(author['handle'] ?? ''),
        text: String(record['text'] ?? ''),
        uri: String(rec['uri'] ?? ''),
      };
    });
  }
}

// ---- M35-4: 実行系(app password認証・岩戸ゲート経由でのみ実行される) ----

export interface BlueskyCredentials {
  identifier: string;
  appPassword: string;
}

/** secretsの 'bluesky' スロット(JSON文字列)から資格情報を取り出す。不正はnull */
export function parseBlueskyCredentials(raw: string | null | undefined): BlueskyCredentials | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const identifier = String(parsed['identifier'] ?? '').trim();
    const appPassword = String(parsed['appPassword'] ?? '').trim();
    if (identifier === '' || appPassword === '') return null;
    return { identifier, appPassword };
  } catch {
    return null;
  }
}

/** POST可能なfetch(テスト注入用)= FetchLike と同形 */
export type JsonFetchLike = FetchLike;

const PDS = 'https://bsky.social';

/**
 * M58: 検索用のアクセストークンを取る(読むだけ。書き込みはしない)。
 * 資格情報が無ければ null = 検索できない(巡回の神はその旨を報告する)。
 * 15分だけ使い回す(巡回は1時間に1回。毎キーワードでログインし直す必要は無い)
 */
export function makeTokenProvider(
  creds: () => BlueskyCredentials | null,
  fetchImpl: JsonFetchLike = (url, init) => fetch(url, init),
  nowFn: () => number = () => Date.now(),
): () => Promise<string | null> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached !== null && cached.until > nowFn()) return cached.token;
    const c = creds();
    if (c === null) return null;
    const res = await fetchImpl(`${PDS}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: c.identifier, password: c.appPassword }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const token = String(data['accessJwt'] ?? '');
    if (token === '') return null;
    cached = { token, until: nowFn() + 15 * 60_000 };
    return token;
  };
}

/** M-blob: Blueskyのblob上限(バイト)。超えるとuploadBlobがサーバ側で拒否されるため事前に弾く */
const MAX_BLOB_BYTES = 1_000_000;
/**
 * M99-12: 動画の上限。GIFは画像扱いだとBluesky側で静止画化されて動かない(実機で発覚)ので、
 * 動画は app.bsky.embed.video で埋め込む。サーバ側の上限は公表が揺れるため、ここでは
 * 控えめに20MBで事前に弾く(超えていたらサーバのエラーがそのまま出る)
 */
const MAX_VIDEO_BYTES = 20_000_000;

/** 拡張子→MIMEタイプ。この一覧のみ対応(それ以外は明示的にエラー) */
function mimeTypeForMedia(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.gif':
      return 'image/gif';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      // GIFを動かしたいときもこちら(画像GIFは静止画化される)。ffmpegで gif→mp4 に変換して指定する
      return 'video/mp4';
    default:
      throw new Error(
        `unsupported media type: 拡張子 '${ext}' はBluesky添付に未対応(gif/png/jpg/jpeg/webp/mp4のみ)`,
      );
  }
}

/**
 * AT Protocol の書き込みクライアント。呼び出しは岩戸ゲートの executor からのみ
 * (= 人間の承認後)。セッションは実行ごとに作る(頻度が低いためキャッシュ不要)。
 */
export class BlueskyWriter {
  constructor(
    private readonly creds: BlueskyCredentials,
    private readonly fetchImpl: JsonFetchLike = (url, init) => fetch(url, init),
  ) {}

  private async login(): Promise<{ accessJwt: string; did: string }> {
    const res = await this.fetchImpl(`${PDS}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: this.creds.identifier, password: this.creds.appPassword }),
    });
    if (!res.ok) throw new Error(`Bluesky認証失敗(HTTP ${res.status})。identifier/app passwordを確認`);
    const data = (await res.json()) as Record<string, unknown>;
    return { accessJwt: String(data['accessJwt'] ?? ''), did: String(data['did'] ?? '') };
  }

  private async createRecord(
    session: { accessJwt: string; did: string },
    collection: string,
    record: Record<string, unknown>,
  ): Promise<string> {
    const res = await this.fetchImpl(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessJwt}`,
      },
      body: JSON.stringify({ repo: session.did, collection, record }),
    });
    if (!res.ok) throw new Error(`Bluesky書き込み失敗(HTTP ${res.status})`);
    const data = (await res.json()) as Record<string, unknown>;
    return String(data['uri'] ?? '');
  }

  /** 画像/GIFをBlueskyのblobストアへアップロードし、応答の blob フィールドを返す */
  async uploadBlob(session: { accessJwt: string }, bytes: Uint8Array, mimeType: string): Promise<unknown> {
    const res = await this.fetchImpl(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessJwt}`,
        'content-type': mimeType,
      },
      body: bytes,
    });
    if (!res.ok) throw new Error(`Bluesky画像アップロード失敗(HTTP ${res.status})`);
    const data = (await res.json()) as Record<string, unknown>;
    return data['blob'];
  }

  async post(text: string, mediaPath?: string, mediaAlt?: string): Promise<string> {
    const session = await this.login();
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: text.slice(0, 300),
      createdAt: new Date().toISOString(),
    };
    if (mediaPath !== undefined) {
      // 拡張子チェックはファイル読み込み前に行う(未対応拡張子で不要なI/Oをしない)
      const mimeType = mimeTypeForMedia(mediaPath);
      const isVideo = mimeType.startsWith('video/');
      const bytes = await readFile(mediaPath);
      const limit = isVideo ? MAX_VIDEO_BYTES : MAX_BLOB_BYTES;
      if (bytes.byteLength > limit) {
        throw new Error(
          `${isVideo ? '動画' : '画像'}サイズ(${bytes.byteLength}バイト)がBluesky blob上限(${limit}バイト)を超過している`,
        );
      }
      const blob = await this.uploadBlob(session, bytes, mimeType);
      // M99-12: 動画は embed.video(画像扱いのGIFは静止画化されて動かない)
      record['embed'] = isVideo
        ? { $type: 'app.bsky.embed.video', video: blob, alt: mediaAlt ?? '' }
        : { $type: 'app.bsky.embed.images', images: [{ image: blob, alt: mediaAlt ?? '' }] };
    }
    const uri = await this.createRecord(session, 'app.bsky.feed.post', record);
    return `投稿した: ${uri}`;
  }

  async follow(handle: string): Promise<string> {
    const clean = handle.replace(/^@/, '').trim();
    const res = await this.fetchImpl(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(clean)}`,
    );
    if (!res.ok) throw new Error(`ハンドル解決失敗: @${clean}(HTTP ${res.status})`);
    const did = String(((await res.json()) as Record<string, unknown>)['did'] ?? '');
    if (did === '') throw new Error(`ハンドル解決失敗: @${clean}`);
    const session = await this.login();
    await this.createRecord(session, 'app.bsky.graph.follow', {
      $type: 'app.bsky.graph.follow',
      subject: did,
      createdAt: new Date().toISOString(),
    });
    return `@${clean} をフォローした`;
  }

  async reply(text: string, parentUri: string): Promise<string> {
    // 親投稿のcid・rootを取得(公開API)
    const res = await this.fetchImpl(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(parentUri)}`,
    );
    if (!res.ok) throw new Error(`親投稿の取得失敗(HTTP ${res.status})`);
    const data = (await res.json()) as Record<string, unknown>;
    const posts = data['posts'];
    const parent = Array.isArray(posts) ? (posts[0] as Record<string, unknown> | undefined) : undefined;
    if (parent === undefined) throw new Error('親投稿が見つからない(削除された可能性)');
    const parentRef = { uri: String(parent['uri']), cid: String(parent['cid']) };
    const parentRecord = (parent['record'] ?? {}) as Record<string, unknown>;
    const parentReply = parentRecord['reply'] as { root?: { uri: string; cid: string } } | undefined;
    const rootRef = parentReply?.root ?? parentRef;
    const session = await this.login();
    const uri = await this.createRecord(session, 'app.bsky.feed.post', {
      $type: 'app.bsky.feed.post',
      text: text.slice(0, 300),
      createdAt: new Date().toISOString(),
      reply: { root: rootRef, parent: parentRef },
    });
    return `返信した: ${uri}`;
  }
}

/**
 * M35-4: 資格情報の有無で宣言と実装が同時に切り替わる(宣言と実挙動の一致)。
 * 資格情報なし: execute空=提案のみ。あり: post/follow/reply(岩戸ゲート経由のみ)。
 */
export function createBlueskyAdapter(
  creds: BlueskyCredentials | null = null,
  fetchImpl?: JsonFetchLike,
): AdapterRuntime {
  if (creds === null) {
    return {
      id: 'bluesky',
      capabilities: { read: true, search: true, draft: true, execute: [] },
      compliance:
        'AT Protocolは自動化に寛容(Bot開示が礼儀)。実行系は設定→接続でapp passwordを登録すると有効化(承認制)',
    };
  }
  const writer = new BlueskyWriter(creds, fetchImpl);
  return {
    id: 'bluesky',
    capabilities: { read: true, search: true, draft: true, execute: ['post', 'follow', 'reply'] },
    compliance:
      'AT Protocol(app password認証)。投稿・フォロー・返信は承認後のみ。プロフィールに「一部運用を自動化(承認制)」の開示を推奨',
    executor: async (action, params) => {
      if (action === 'post') {
        const mediaPath = params['mediaPath'];
        const mediaAlt = params['mediaAlt'];
        return writer.post(
          String(params['text'] ?? ''),
          typeof mediaPath === 'string' ? mediaPath : undefined,
          typeof mediaAlt === 'string' ? mediaAlt : undefined,
        );
      }
      if (action === 'follow') return writer.follow(String(params['handle'] ?? ''));
      if (action === 'reply') return writer.reply(String(params['text'] ?? ''), String(params['parentUri'] ?? ''));
      throw new Error(`未知のアクション: ${action}`);
    },
  };
}
