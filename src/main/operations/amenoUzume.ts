import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CommunityCandidate,
  ProjectProfile,
  MediaStrategyEntry,
  MetricsSnapshot,
  OperationsDraft,
} from '../../shared/types';
import { extractJson } from './llm';

/**
 * M32-4: AMENO-uzume(アメノウズメ)— 広報と仲間探し。
 * すべて「下書き・提示」まで。投稿ボタンは作らない(大原則)。
 * LLM実行は manager が行い、このモジュールはプロンプト構築・パース・保存を担う。
 */

// ---- 発信ドラフト ----

/**
 * M57: 既存データの是正。Zenn(published:false)とGitHub Release(draft)へ出した下書きは
 * 「投稿済み」として記録されていたが、**どちらも外からは誰も読めない**。
 * 実機には zenn 4件がこの状態で残っており、神議はそれを「投下した発信」として数え、
 * 反応の無さを「物量>質」と誤診していた。読み込み時に staged(公開待ち)へ倒す。
 */
function migrateStaged(d: OperationsDraft): OperationsDraft {
  const notPublic = d.media === 'zenn' || d.media === 'github';
  return d.status === 'posted' && notPublic ? { ...d, status: 'staged' } : d;
}

export class DraftStore {
  private readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, 'drafts.json');
    mkdirSync(dir, { recursive: true });
  }

  list(): OperationsDraft[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as OperationsDraft[]).map(migrateStaged) : [];
    } catch {
      return [];
    }
  }

  private save(drafts: OperationsDraft[]): void {
    writeFileSync(this.path, JSON.stringify(drafts, null, 1), 'utf8');
  }

  add(drafts: Omit<OperationsDraft, 'id' | 'createdAt' | 'status'>[]): OperationsDraft[] {
    const all = this.list();
    const created = drafts.map((d) => ({
      ...d,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'draft' as const,
    }));
    this.save([...all, ...created]);
    return created;
  }

  /** 投稿済み/破棄マーク+本文編集。投稿済みは postedAt を刻む(OMOI-kami突き合わせ用) */
  update(
    id: string,
    patch: Partial<Pick<OperationsDraft, 'status' | 'body' | 'title' | 'media'>>,
  ): OperationsDraft | null {
    const all = this.list();
    const idx = all.findIndex((d) => d.id === id);
    const target = all[idx];
    if (target === undefined) return null;
    const next: OperationsDraft = { ...target, ...patch };
    if (patch.status === 'posted' && target.status !== 'posted') {
      next.postedAt = new Date().toISOString();
    }
    all[idx] = next;
    this.save(all);
    return next;
  }
}

/** 見せ場抽出→下書き生成のプロンプト */
export function buildHighlightPrompt(input: {
  progressExcerpt: string;
  recentCommits: string;
  current: MetricsSnapshot | null;
  previous: MetricsSnapshot | null;
  /** M41-3: 運営対象プロジェクト(未設定ならリポジトリ名から推測された値が入る) */
  project: ProjectProfile;
}): string {
  const metricsNote = input.current
    ? JSON.stringify({ current: input.current, previous: input.previous ?? undefined })
    : '(メトリクスなし)';
  return `あなたはOSSプロジェクト ${input.project.name} の広報担当(アメノウズメ)。開発記録から「見せ場」を抽出し、発信の下書きを作る。

# プロジェクト
${input.project.name}: ${input.project.description}

# 素材: PROGRESS.md 直近抜粋
${input.progressExcerpt.slice(0, 6000)}

# 素材: 直近コミット
${input.recentCommits.slice(0, 2000)}

# 素材: メトリクス(current/previous)
${metricsNote}

# ルール
- 誇張しない。実際にやったこと・実際の数字だけを使う
- 失敗談・ヒヤリ話は隠さず見せ場として扱う(この製品の信頼はガードの実話で成り立つ)
- X投稿は日本語で140字目安(ハッシュタグ込み)。リンクプレースホルダは {URL} と書く

# 書いてはいけない話題(未公開機能。ここだけは絶対)
カメラ・マイク・音声・在席や見守りの判定・常時聴取・文字起こし・ウェイクワードに関する
機能の話は、**まだ公開していない**。素材に断片が残っていても書かないこと。
言い換え(「見守り判定」「通り過ぎただけでおかえり」等)も同じく禁止 — 実際にそう書いて捨てられた。

# 書くべき話題(素材にあるもの。ここから必ず1件以上作る)
承認ゲート(岩戸)・自己進化(worktree隔離と検証ゲート)・運営の自律(神議)・
「壊れていたのに成功を報告していた」類の失敗談と、その直し方。
この製品の信頼は**ガードと失敗の実話**で成り立つ。素材の失敗談こそ一番の見せ場として扱うこと

# 出力(JSONのみ。コードフェンス可)
[
 {"kind":"x-post","title":"見せ場の一言","body":"投稿文(140字目安)"},
 {"kind":"release-note","title":"リリースノート見出し","body":"Markdown本文(見出し+箇条書き)"},
 {"kind":"article-outline","title":"記事タイトル案","body":"Markdownアウトライン(H2〜H3)"}
]`;
}

/**
 * M37: 記事アウトライン → Zenn記事の本文(Markdown)。
 * frontmatter はコード側(zennRepo.buildArticleMarkdown)で必ず published: false を付けるので、
 * LLMには本文だけを書かせる。
 */
export function buildArticleOutlinePrompt(input: {
  title: string;
  outline: string;
  progressExcerpt: string;
  project: ProjectProfile;
}): string {
  return `あなたはOSSプロジェクト ${input.project.name}(${input.project.description})の技術記事ライター。以下のアウトラインからZennの記事本文(Markdown)を書く。

# 記事タイトル
${input.title}

# アウトライン
${input.outline.slice(0, 4000)}

# 素材: PROGRESS.md 直近抜粋(事実確認用。ここに無いことは書かない)
${input.progressExcerpt.slice(0, 6000)}

# 書いてはいけない話題(M75: これを書かなかったため、公開リポジトリに未公開機能が出た)
未公開機能「月読(TUKU-yomi)」に関わることは**一言も書かない**。
具体的には、音声認識・文字起こし・マイク・カメラ・在席検知・見守り・おかえり・発話・
ウェイクワード・VAD など、**まだ世に出していない機能**の話題。
素材(PROGRESS.md)に書いてあっても、面白くても、例示としてでも、書いてはいけない。
「未公開機能がある」という事実にも触れない。触れそうになったら、その話題ごと落とすこと。

# ルール
- 誇張・推測を書かない。実際にやったこと・実際の数字だけを使う
- frontmatter(---で囲む部分)は書かない。本文(H2見出しから)だけを出力する
- 日本語。コードブロックには言語指定を付ける
- 失敗談・ヒヤリ話は隠さない(この製品の信頼はガードの実話で成り立つ)
- ただし失敗談が未公開機能に関わる場合は、その失敗談自体を書かない(上のルールが優先)

# 出力
Markdown本文のみ(前置き・後書きの説明文は不要)`;
}

export function parseDrafts(raw: string): Omit<OperationsDraft, 'id' | 'createdAt' | 'status'>[] {
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed)) return [];
  const kinds = new Set(['x-post', 'release-note', 'article-outline', 'reply', 'weekly-report']);
  const out: Omit<OperationsDraft, 'id' | 'createdAt' | 'status'>[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const kind = String(rec['kind'] ?? '');
    const title = String(rec['title'] ?? '').trim();
    const body = String(rec['body'] ?? '').trim();
    if (!kinds.has(kind) || title === '' || body === '') continue;
    out.push({ kind: kind as OperationsDraft['kind'], title, body });
  }
  return out;
}

// ---- メディア戦略ボード ----

/** OPERATIONS_DESIGN.md の媒体ポートフォリオ(初期データ) */
export const MEDIA_PORTFOLIO: readonly Omit<MediaStrategyEntry, 'nextAction'>[] = [
  { media: 'zenn', audience: '日本語圏エンジニア', note: 'トレンドはいいね初速で決まる。週1記事(build in public)' },
  { media: 'hatena', audience: '日本語圏テック一般', note: 'セルフブクマ1users目はOK。記事と同日に' },
  { media: 'x', audience: '日本語圏個人開発者', note: '自動投稿・自動フォロー禁止(規約)。デモGIF付きが効く' },
  { media: 'hn', audience: '英語圏(Show HN)', note: '米国朝(JST 21〜24時)投稿。コメント即応が必須' },
  { media: 'reddit', audience: '英語圏(r/ClaudeAI等)', note: 'Show HN後日。宣伝臭に厳しい。実験の話として' },
  { media: 'bluesky', audience: '英語圏AI開発者', note: 'API自動化に寛容(Bot開示が礼儀)。現状読み取りのみ' },
  { media: 'youtube', audience: '中期・デモ動画', note: 'インストーラ成熟後。短尺から' },
  { media: 'producthunt', audience: '中期・プロダクト層', note: 'インストーラ+英語ドキュメント成熟後' },
] as const;

/** 現在のメトリクスから媒体ごとの次アクションを提案(静的ヒューリスティクス) */
export function strategyBoard(current: MetricsSnapshot | null): MediaStrategyEntry[] {
  const stars = current ? Object.values(current.github).reduce((a, m) => a + m.stars, 0) : 0;
  const zennLiked = current ? Object.values(current.zenn).reduce((a, m) => a + m.liked, 0) : 0;
  return MEDIA_PORTFOLIO.map((entry) => {
    let nextAction = '発信ドラフトを生成して投稿(人間が実行)';
    if (entry.media === 'zenn') {
      nextAction =
        zennLiked < 5
          ? '公開済み記事の初速づくり: X・はてブと同日展開で回遊を作る。次記事の仕込み(岩戸開き=運営自動化)'
          : '次の記事を出す(週1ペース維持)';
    }
    if (entry.media === 'hn') {
      nextAction =
        stars < 30
          ? 'Show HN投稿の下書きを準備(README.en整備済み)。投稿はJST21〜24時・張り付ける日に'
          : 'Show HN実施済みなら、コメントで出た論点を記事化';
    }
    if (entry.media === 'x') nextAction = 'デモGIF付きでZenn記事を投稿(下書きはAMENO-uzumeが生成)';
    if (entry.media === 'hatena') nextAction = 'Zenn記事をセルフブクマ(1users目)';
    if (entry.media === 'bluesky') nextAction = 'AI開発者の検索で仲間発見(候補カード化)';
    return { ...entry, nextAction };
  });
}

// ---- 仲間発見(コミュニティ・ディスカバリー) ----

export class CandidateStore {
  private readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, 'candidates.json');
    mkdirSync(dir, { recursive: true });
  }

  list(): CommunityCandidate[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as CommunityCandidate[]) : [];
    } catch {
      return [];
    }
  }

  private save(all: CommunityCandidate[]): void {
    writeFileSync(this.path, JSON.stringify(all, null, 1), 'utf8');
  }

  add(candidate: Omit<CommunityCandidate, 'id' | 'createdAt' | 'status'>): CommunityCandidate {
    const all = this.list();
    const created: CommunityCandidate = {
      ...candidate,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'new',
    };
    this.save([...all, created]);
    return created;
  }

  resolve(id: string, status: 'kept' | 'discarded'): CommunityCandidate | null {
    const all = this.list();
    const idx = all.findIndex((c) => c.id === id);
    const target = all[idx];
    if (target === undefined) return null;
    all[idx] = { ...target, status };
    this.save(all);
    return all[idx];
  }
}

/**
 * 貼り付けテキストの「本当にAIを楽しんでいる人か」評価プロンプト。
 * ヒューリスティクスは設計書どおり(自作公開/失敗談/売り込み導線なし/宣伝より実験)。
 */
export function buildCandidatePrompt(pastedText: string): string {
  return `あなたはコミュニティ担当(アメノウズメ)。以下はSNSのプロフィール/投稿の貼り付け。
「本当にAIを楽しんでいる人(商売目的でない)」かを判定する。

# 判定ヒューリスティクス
- 自作の作品・コードを公開している
- 技術的な失敗談を書く(成功アピールだけでない)
- 有料note・情報商材・LINE誘導などの売り込み導線が「無い」
- 宣伝より実験・プロセスの話が多い

# 貼り付けテキスト
${pastedText.slice(0, 4000)}

# 出力(JSONのみ)
{
 "verdict": "match" | "no-match" | "unclear",
 "reasons": ["判定理由を1〜4個。テキスト中の根拠を引用しつつ"],
 "replyDraft": "match の場合のみ: その人の直近の話題への返信下書き(日本語・宣伝ではなく内容への具体的な反応。プロジェクトの宣伝文を入れない)"
}`;
}

export function parseCandidate(
  raw: string,
  source: string,
  pastedText: string,
): Omit<CommunityCandidate, 'id' | 'createdAt' | 'status'> | null {
  const parsed = extractJson(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const verdict = rec['verdict'];
  if (verdict !== 'match' && verdict !== 'no-match' && verdict !== 'unclear') return null;
  const reasons = Array.isArray(rec['reasons']) ? (rec['reasons'] as unknown[]).map(String) : [];
  const replyDraft = typeof rec['replyDraft'] === 'string' && rec['replyDraft'].trim() !== '' ? rec['replyDraft'] : undefined;
  return {
    source,
    profile: pastedText.slice(0, 2000),
    verdict,
    reasons,
    ...(verdict === 'match' && replyDraft !== undefined ? { replyDraft } : {}),
  };
}
