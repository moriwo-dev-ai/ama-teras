import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUS_CHANNELS } from '../core/events';
import { TALK_LIMIT, TalkLog } from './talkLog';

/**
 * M43-2(TUKU-yomi): 会話ログ。
 * **ここには生の発話が残る**。だから固定するのは「消せる」「無限に貯めない」
 * 「スマホ(remote-ui)へ中継しない」の3点。
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-talk-'));
  path = join(dir, 'talks.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('M43-2(TUKU-yomi) 会話ログ', () => {
  it('時系列で返る(チャットなので下が最新)', () => {
    const log = new TalkLog(path);
    log.add({ role: 'you', text: '明日の予定は?' });
    log.add({ role: 'tsukuyomi', text: '13時にレビューの約束があります。' });
    log.add({ role: 'action', text: 'レビューの予定を帳に入れた' });

    const list = log.list();
    expect(list.map((t) => t.role)).toEqual(['you', 'tsukuyomi', 'action']);
    expect(list[0]?.text).toBe('明日の予定は?');
  });

  it('全部消せる(生の発話を残す以上、消す手段が無いのは事故)', () => {
    const log = new TalkLog(path);
    log.add({ role: 'you', text: '消えてほしい話' });
    log.clear();
    expect(log.list()).toEqual([]);
  });

  it('無限に貯めない(上限を超えたら古い方から見えなくなる)', () => {
    const log = new TalkLog(path);
    for (let i = 0; i < TALK_LIMIT + 10; i++) log.add({ role: 'you', text: `発話${i}` });
    const list = log.list();
    expect(list).toHaveLength(TALK_LIMIT);
    expect(list[list.length - 1]?.text).toBe(`発話${TALK_LIMIT + 9}`);
  });

  it('壊れた行(電源断)があってもログ全体を捨てない', () => {
    writeFileSync(path, `{"role":"you","text":"生きてる行"}\n{"role":"you","text":壊れ\n`, 'utf8');
    expect(new TalkLog(path).list().map((t) => t.text)).toEqual(['生きてる行']);
  });

  /** 生の発話がスマホに流れたら事故。tsukuyomi:event は SSE 中継対象に入れない(M42からの約束) */
  it('月読のイベントはスマホ(remote-ui)へ中継しない', () => {
    expect(BUS_CHANNELS).not.toContain('tsukuyomi:event');
  });
});
