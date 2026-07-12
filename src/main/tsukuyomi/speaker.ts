import type { RunInfo } from '../../shared/types';

/**
 * M42-2(TUKU-yomi): 口 — 発話判断の関所。
 *
 * ここは「何を喋るか」を決める純関数だけを置く。**喋ってよいかの判断(予算・静音時間)は
 * manager が budget.ts を通して行う** — 賢さより「黙るべき時を知る」が価値(鉄則3)。
 *
 * 文言は月らしく短く控えめに。多弁な相棒は嫌われる。
 */

export type SpeakTrigger =
  | { kind: 'runs-finished'; label: string }
  | { kind: 'approval-waiting'; count: number }
  | { kind: 'welcome-back'; whileAway: string[] };

/** 文言テーブル(テストで固定。ここを変える時は必ずテストも見る) */
export function speechFor(trigger: SpeakTrigger): string | null {
  switch (trigger.kind) {
    case 'runs-finished':
      return trigger.label === ''
        ? '作業が終わったよ'
        : `${trigger.label} が終わったよ`;
    case 'approval-waiting':
      if (trigger.count <= 0) return null; // 0件で喋りかけない
      return trigger.count === 1 ? '承認待ちが1件あるよ' : `承認待ちが${trigger.count}件たまってるよ`;
    case 'welcome-back': {
      if (trigger.whileAway.length === 0) return 'おかえり';
      const first = trigger.whileAway[0] ?? '';
      const rest = trigger.whileAway.length - 1;
      return rest > 0
        ? `おかえり。留守中に${first}(ほか${rest}件)`
        : `おかえり。留守中に${first}`;
    }
  }
}

/**
 * ラン一覧の変化から「終わったもの」を拾う(前回との差分)。
 * 実行中→消えた = 完了。開始や進行では喋らない(うるさいので)
 */
export function finishedRuns(prev: RunInfo[], next: RunInfo[]): RunInfo[] {
  const nextIds = new Set(next.map((r) => r.sessionId));
  return prev.filter((r) => !nextIds.has(r.sessionId));
}

/** ランの表示名(月が読み上げる短い名前)。長いタイトルは切る */
export function runLabel(run: RunInfo): string {
  const title = run.title.trim();
  if (title === '') return '';
  return title.length > 24 ? `${title.slice(0, 24)}…` : title;
}
