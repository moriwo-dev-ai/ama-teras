import type { SessionMeta } from './types';

/**
 * M17-3: 左ペインのプロジェクトグループ化とソート(純関数・テスト可能)。
 * 並び順は「プロジェクト配下セッションの最新 updatedAt の降順」に固定する。
 * = 実際に書き込み(新メッセージ・ツール実行)があったプロジェクトだけが上に来る。
 * 「選択中のプロジェクトを先頭へ移動」はしない(選択=閲覧では並びを変えない。
 * 選択中の明示はハイライトのみで行う)。同時刻は安定(元の並び=セッション一覧順)。
 */
export function groupSessionsByProject(sessions: SessionMeta[]): [string, SessionMeta[]][] {
  const map = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const key = s.workspace || '(既定)';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  const latest = (items: SessionMeta[]): number =>
    items.reduce((max, s) => {
      const t = Date.parse(s.updatedAt);
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
  // sort は安定なので、最新時刻が同じグループは出現順(=一覧順)を保つ
  return [...map.entries()].sort((a, b) => latest(b[1]) - latest(a[1]));
}
