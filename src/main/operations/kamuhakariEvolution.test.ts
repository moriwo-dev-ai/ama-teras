import { describe, expect, it } from 'vitest';
import { buildKamuhakariPrompt } from './kamuhakari';

/**
 * M52: **神議は進化ジョブの状態を1バイトも渡されていなかった**。
 * その結果、ゲートで落ちたジョブ#16を「承認待ち」と呼び、存在しない滞留の
 * レビューを人間に催促する提案を出した(実害。承認しても何も起きない空提案)。
 *
 * 起票だけさせて結果を見せないのは、神議を盲目のまま働かせるのと同じ。
 */
const base = {
  unread: [],
  history: [],
  postedDrafts: [],
  jobs: [],
  currentKeywords: [],
  project: { name: 'テスト製品', description: '説明' },
};

describe('M52: 神議は進化ジョブの実状態を見る', () => {
  it('失敗したジョブは「失敗」として、理由と落ちたゲートごとプロンプトに載る', () => {
    const prompt = buildKamuhakariPrompt({
      ...base,
      evolutionJobs: [
        {
          id: 16,
          description: '[神議] 体験ギャップ検出',
          status: 'failed',
          error: 'vitest が sweep.test.ts のタイムアウトで不合格',
          log: [],
          gates: [
            { name: 'typecheck', ok: true, detail: '合格' },
            { name: 'vitest', ok: false, detail: 'timeout' },
          ],
        },
      ],
    });

    expect(prompt).toContain('#16');
    expect(prompt).toContain('failed');
    expect(prompt).toContain('落ちたゲート: vitest');
    expect(prompt).toContain('sweep.test.ts のタイムアウト');
  });

  it('「failedは終わっている/推測で滞留を語るな/催促だけの提案を出すな」と明示する', () => {
    const prompt = buildKamuhakariPrompt({ ...base, evolutionJobs: [] });

    expect(prompt).toContain('進化ジョブの実状態');
    expect(prompt).toContain('承認待ちではない');
    expect(prompt).toContain('推測で書かないこと');
    expect(prompt).toContain('催促するだけの提案');
  });
});
