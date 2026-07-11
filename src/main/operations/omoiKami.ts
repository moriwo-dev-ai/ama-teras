import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MetricsSnapshot,
  OperationsConfig,
  OperationsDraft,
  RepoMetrics,
  ZennMetrics,
} from '../../shared/types';
import type { GithubReader } from './adapters/github';
import type { FetchLike, ZennReader } from './adapters/zenn';

/**
 * M32-3: OMOI-kami(オモイカネ)— 観測と戦略。
 * アダプタ経由でメトリクスを収集し、時系列JSONL(userData/operations/metrics.jsonl)に蓄積。
 * 週報はプロンプト構築までを担い、LLM実行は manager が行う(このモジュールはLLM非依存)。
 */

export class OmoiKami {
  private readonly metricsPath: string;

  constructor(
    private readonly dir: string,
    private readonly deps: {
      github: GithubReader | null;
      zenn: ZennReader;
      fetchImpl?: FetchLike;
    },
  ) {
    this.metricsPath = join(dir, 'metrics.jsonl');
  }

  /** 現在値を全アダプタから収集し、時系列へ追記して返す */
  async collectSnapshot(cfg: OperationsConfig, registryUrl?: string): Promise<MetricsSnapshot> {
    const github: Record<string, RepoMetrics> = {};
    if (this.deps.github) {
      for (const repo of cfg.repos) {
        try {
          github[repo] = await this.deps.github.repoMetrics(repo);
        } catch {
          // 個別リポジトリの失敗はスナップショット全体を壊さない
        }
      }
    }
    const zenn: Record<string, ZennMetrics> = {};
    for (const slug of cfg.zennSlugs) {
      const m = await this.deps.zenn.articleMetrics(slug);
      if (m !== null) zenn[slug] = m;
    }
    const snapshot: MetricsSnapshot = { ts: new Date().toISOString(), github, zenn };

    if (registryUrl !== undefined && registryUrl.trim() !== '') {
      try {
        const fetchImpl = this.deps.fetchImpl ?? ((url: string) => fetch(url));
        const res = await fetchImpl(`${registryUrl.replace(/\/+$/, '')}/index.json`);
        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const plugins = data['plugins'];
          if (Array.isArray(plugins)) snapshot.registry = { plugins: plugins.length };
        }
      } catch {
        // レジストリ不達はスキップ
      }
    }

    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.metricsPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
    } catch {
      // 蓄積失敗でも現在値は返す(表示優先)
    }
    return snapshot;
  }

  /** 直近 limit 件(古い順)。壊れた行はスキップ */
  history(limit = 30): MetricsSnapshot[] {
    try {
      const lines = readFileSync(this.metricsPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '');
      const out: MetricsSnapshot[] = [];
      for (const line of lines.slice(-Math.max(0, limit))) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === 'object' && parsed !== null && typeof (parsed as MetricsSnapshot).ts === 'string') {
            out.push(parsed as MetricsSnapshot);
          }
        } catch {
          // skip
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 週報プロンプト。時系列+referrer+投下履歴(投稿済みドラフト)を突き合わせ、
   * 「何が効いたか・次の一手」の下書きをLLMに書かせる。
   */
  buildWeeklyReportPrompt(snapshots: MetricsSnapshot[], postedDrafts: OperationsDraft[]): string {
    const series = snapshots
      .map((s) => {
        const gh = Object.entries(s.github)
          .map(
            ([repo, m]) =>
              `${repo}: ★${m.stars} fork${m.forks} 閲覧${m.views ?? '?'}(u${m.viewsUnique ?? '?'}) clone${m.clones ?? '?'} DL${m.downloads ?? '?'}`,
          )
          .join(' / ');
        const zn = Object.entries(s.zenn)
          .map(([slug, m]) => `zenn:${slug} ♥${m.liked} 💬${m.comments}`)
          .join(' ');
        return `- ${s.ts.slice(0, 16)} ${gh} ${zn}`;
      })
      .join('\n');
    const latest = snapshots[snapshots.length - 1];
    const referrers = latest
      ? Object.entries(latest.github)
          .flatMap(([repo, m]) => (m.referrers ?? []).map((r) => `${repo} ← ${r.referrer}: ${r.count}(u${r.uniques})`))
          .join('\n')
      : '';
    const posted = postedDrafts
      .map((d) => `- ${d.postedAt ?? d.createdAt} [${d.media ?? '?'}] ${d.title}`)
      .join('\n');

    return `あなたはOSSプロジェクトの運営参謀(オモイカネ)。以下の観測データから週報を日本語で書く。

# メトリクス時系列
${series === '' ? '(データなし)' : series}

# 流入元(referrer・直近)
${referrers === '' ? '(データなし)' : referrers}

# 投下履歴(投稿済みマークされた発信)
${posted === '' ? '(なし)' : posted}

# 出力形式(Markdown)
## 今週のサマリ(数字の変化を1段落で)
## 何が効いたか(投下履歴とreferrer・数値変化の突き合わせ。因果の断定は避け「相関」として書く)
## 次の一手(具体的な3つ以内。各1〜2行)

データが乏しい場合は正直に「まだ観測データが少ない」と書き、憶測で効果を語らないこと。`;
  }

  /** 最新と1つ前(表示の前回比用) */
  latestPair(): { current: MetricsSnapshot | null; previous: MetricsSnapshot | null } {
    const h = this.history(2);
    return { current: h[h.length - 1] ?? null, previous: h.length >= 2 ? h[0] ?? null : null };
  }
}
