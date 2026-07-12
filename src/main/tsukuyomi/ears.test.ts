import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { EXTRACT_PROMPT, extractPromptFor, parseExtraction } from './extractor';
import { MAX_PENDING_TRANSCRIBES, TsukuyomiManager } from './manager';
import {
  parseWhisperOutput,
  sweepTmpWavs,
  threadCount,
  transcribe,
  whisperArgs,
  whisperPaths,
  whisperReady,
} from './transcriber';

let dir: string;
let tmp: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-ears-'));
  tmp = mkdtempSync(join(tmpdir(), 'tsuku-wav-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

/** whisper のバイナリ・モデルを置いたことにする(中身は使わない=偽ランナーで動かす) */
function placeWhisper(): ReturnType<typeof whisperPaths> {
  const paths = whisperPaths(dir);
  mkdirSync(join(dir, 'tsukuyomi', 'models'), { recursive: true });
  writeFileSync(paths.bin, 'dummy');
  writeFileSync(paths.model, 'dummy');
  return paths;
}

function fakeProvider(reply: string): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta', text: reply };
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [] },
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 0 },
      };
    },
  };
}

describe('M42-5(TUKU-yomi) 耳: 音声はAPIに送らない・一時ファイルは必ず消す', () => {
  it('whisper未配置なら文字起こししない(勝手にダウンロードもしない)', async () => {
    expect(whisperReady(whisperPaths(dir))).toBe(false);
    await expect(transcribe(Buffer.from('wav'), whisperPaths(dir))).rejects.toThrow('未配置');
  });

  it('文字起こし後に一時WAVを削除する(成功時)', async () => {
    const paths = placeWhisper();
    let seenWav: string | null = null;
    const runner = vi.fn(async (args: string[]) => {
      seenWav = args[args.indexOf('-f') + 1] ?? null;
      expect(existsSync(seenWav ?? '')).toBe(true); // 実行中は存在する
      return '[00:00:00.000 --> 00:00:03.000]   明日レビューをやると伝えた\n';
    });

    const text = await transcribe(Buffer.from('wav'), paths, { runner, tmpDir: tmp });
    expect(text).toBe('明日レビューをやると伝えた');
    expect(existsSync(seenWav ?? '')).toBe(false); // 終わったら消えている
    expect(readdirSync(tmp)).toHaveLength(0);
  });

  it('**失敗しても**一時WAVを削除する(録音が残るアプリにしない)', async () => {
    const paths = placeWhisper();
    const runner = vi.fn(async () => {
      throw new Error('whisper が落ちた');
    });
    await expect(transcribe(Buffer.from('wav'), paths, { runner, tmpDir: tmp })).rejects.toThrow();
    expect(readdirSync(tmp)).toHaveLength(0); // 残骸ゼロ
  });

  /**
   * 実機: 文字起こし中にアプリを強制終了したら、finally が走らず tmp に録音が1本残った。
   * 落ちた次の起動で拾い直す(「録音が残るアプリ」にしないための最後の砦)
   */
  it('起動時に前回の残骸(落ちた時のWAV)を掃除する。他人のファイルは触らない', () => {
    writeFileSync(join(tmp, 'amateras-tsukuyomi-old.wav'), 'leftover');
    writeFileSync(join(tmp, 'amateras-tsukuyomi-old2.wav'), 'leftover');
    writeFileSync(join(tmp, 'someone-elses.wav'), 'keep');
    writeFileSync(join(tmp, 'amateras-tsukuyomi-notes.txt'), 'keep');

    expect(sweepTmpWavs(tmp)).toBe(2);
    expect(readdirSync(tmp).sort()).toEqual(['amateras-tsukuyomi-notes.txt', 'someone-elses.wav']);
  });

  it('whisper出力からテキストだけを取り出す([BLANK_AUDIO] 等は落とす)', () => {
    const raw = [
      '[00:00:00.000 --> 00:00:02.000]   明日の13時にレビューをやると伝えた',
      '[00:00:02.000 --> 00:00:04.000]   [BLANK_AUDIO]',
      '[00:00:04.000 --> 00:00:06.000]   資料は今日中に作る',
    ].join('\n');
    expect(parseWhisperOutput(raw)).toBe('明日の13時にレビューをやると伝えた 資料は今日中に作る');
  });

  /**
   * 実機(whisper-cli v1.9.1 + ggml-small)で無音2秒を通したら「(音楽)」が返ってきた。
   * こういう幻聴と実行ログを通すと帳がゴミで埋まる
   */
  it('幻聴(括弧だけの行)と実行ログを落とす', () => {
    const raw = ['read_audio_data: trying to decode with miniaudio', '', '(音楽)'].join('\n');
    expect(parseWhisperOutput(raw)).toBe('');
    expect(parseWhisperOutput('(笑)\n明日レビューやる\n【音楽】')).toBe('明日レビューやる');
  });
});

describe('M42-5(TUKU-yomi) 耳: 抽出は「本人の約束」だけ(鉄則1)', () => {
  it('プロンプトが他人の評価・約束を禁じている', () => {
    expect(EXTRACT_PROMPT).toContain('本人自身の');
    expect(EXTRACT_PROMPT).toContain('他人の人物評・感想・約束は書かない');
    expect(EXTRACT_PROMPT).toContain('該当が無ければ [] を返す');
  });

  it('JSONの取り出しは防御的(コードフェンス・前後の説明・壊れたJSONに耐える)', () => {
    expect(parseExtraction('```json\n[{"kind":"todo","text":"資料を作る"}]\n```')).toEqual([
      { kind: 'todo', text: '資料を作る' },
    ]);
    expect(parseExtraction('了解しました。\n[{"kind":"promise","text":"明日13時にレビュー","due":"2026-07-13T13:00"}]')).toEqual([
      { kind: 'promise', text: '明日13時にレビュー', due: '2026-07-13T13:00' },
    ]);
    expect(parseExtraction('壊れた{json')).toEqual([]);
    expect(parseExtraction('[]')).toEqual([]);
    // 不正な kind・空テキストは落とす
    expect(parseExtraction('[{"kind":"gossip","text":"誰それは遅い"},{"kind":"todo","text":""}]')).toEqual([]);
  });

  /**
   * 実機で出た2つの事故:
   * - 「明日の**13時**にレビュー」が「明日**13日**にレビュー」になった(時刻の取り違え=致命的)
   * - due に文字列「省略」がそのまま入って帳に保存された(日付欄に日付でないものが入る)
   */
  it('数字の言い換えを禁じ、due は日付形式のものだけ通す(「省略」は落とす)', () => {
    expect(EXTRACT_PROMPT).toContain('数字・時刻・日付・固有名詞は文字起こしのまま写す');
    expect(EXTRACT_PROMPT).toContain('due のキーごと書かない');

    expect(parseExtraction('[{"kind":"promise","text":"13時にレビュー","due":"省略"}]')).toEqual([
      { kind: 'promise', text: '13時にレビュー' }, // due は付かない
    ]);
    expect(parseExtraction('[{"kind":"promise","text":"レビュー","due":"2026-07-13T13:00"}]')).toEqual([
      { kind: 'promise', text: 'レビュー', due: '2026-07-13T13:00' },
    ]);
    expect(parseExtraction('[{"kind":"todo","text":"資料","due":"2026-07-13"}]')).toEqual([
      { kind: 'todo', text: '資料', due: '2026-07-13' },
    ]);
  });

  it('「明日」を日付に直せるよう、今日の日付をプロンプトに渡す', () => {
    const p = extractPromptFor(new Date(2026, 6, 12));
    expect(p).toContain('今日は 2026-07-12');
    expect(p).toContain('日曜'); // 2026-07-12 は日曜
  });

  it('抽出結果は帳に勝手に書かない(候補を返すだけ。承認は人間)', async () => {
    const paths = placeWhisper();
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () => ({ tsukuyomi: { enabled: true, ears: true } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: () => {},
      visionProvider: () => fakeProvider('[{"kind":"promise","text":"明日13時にレビューをやると伝えた"}]'),
      whisperRunner: async () => '[00:00:00.000 --> 00:00:03.000]   明日レビューやるって伝えて\n',
    });
    expect(whisperReady(paths)).toBe(true);

    const { items } = await manager.transcribeAndExtract(Buffer.from('wav'));
    expect(items).toEqual([{ kind: 'promise', text: '明日13時にレビューをやると伝えた' }]);
    // **帳はまだ空**(承認UIを通ってから入る)
    expect(manager.list()).toEqual([]);
  });

  it('耳がOFFなら文字起こしすらしない', async () => {
    placeWhisper();
    const whisperRunner = vi.fn(async () => '');
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () => ({ tsukuyomi: { enabled: true, ears: false } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: () => {},
      whisperRunner,
    });
    const { items, error } = await manager.transcribeAndExtract(Buffer.from('wav'));
    expect(items).toEqual([]);
    expect(error).toContain('耳がOFF');
    expect(whisperRunner).not.toHaveBeenCalled();
  });
});

describe('M42-5b(TUKU-yomi) 耳: 速度と多重起動(実機で測って決めた)', () => {
  it('スレッド数: 既定4のままだと20コアでも4しか使わない。全コアは奪わない', () => {
    expect(threadCount(20)).toBe(8); // 上限8(裏方が他の作業を止めない)
    expect(threadCount(4)).toBe(2);
    expect(threadCount(1)).toBe(2); // 最低2
  });

  it('引数: 貪欲デコード(-bs 1)とスレッド指定を含む(実機で29秒→21秒)', () => {
    const args = whisperArgs('model.bin', 'a.wav', 20);
    expect(args).toEqual(['-m', 'model.bin', '-f', 'a.wav', '-l', 'ja', '-nt', '--no-prints', '-t', '8', '-bs', '1']);
  });

  it('常時聴取で発話が重なっても whisper を多重起動しない(1件ずつ順番に)', async () => {
    placeWhisper();
    let running = 0;
    let maxConcurrent = 0;
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () => ({ tsukuyomi: { enabled: true, ears: true } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: () => {},
      visionProvider: () => fakeProvider('[]'),
      whisperRunner: async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return 'こんにちは\n';
      },
    });

    await Promise.all([
      manager.transcribeAndExtract(Buffer.from('a')),
      manager.transcribeAndExtract(Buffer.from('b')),
      manager.transcribeAndExtract(Buffer.from('c')),
    ]);
    expect(maxConcurrent).toBe(1); // 同時に走るのは常に1つ
  });

  /**
   * 実機: テレビが点いていると常時聴取は音を拾い続け、列が60件超まで伸びた。
   * 1件20秒級・1件ずつなので追いつかない。**溢れた分は捨てる**(古い音声を抱え込まない)
   */
  it('待ち行列が上限を超えたら、その発話は捨てる(列を無限に伸ばさない)', async () => {
    placeWhisper();
    const whisperRunner = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 'こんにちは\n';
    });
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () => ({ tsukuyomi: { enabled: true, ears: true } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: () => {},
      visionProvider: () => fakeProvider('[]'),
      whisperRunner,
    });

    const results = await Promise.all(
      Array.from({ length: MAX_PENDING_TRANSCRIBES + 2 }, (_, i) =>
        manager.transcribeAndExtract(Buffer.from(String(i))),
      ),
    );
    const dropped = results.filter((r) => r.error?.includes('捨てた') === true);
    expect(dropped).toHaveLength(2); // 上限を超えた2件は捨てられる
    expect(whisperRunner).toHaveBeenCalledTimes(MAX_PENDING_TRANSCRIBES); // 走ったのは上限まで
  });
});
