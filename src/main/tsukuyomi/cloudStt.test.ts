import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { CLOUD_STT_MODEL, isPromptEcho, STT_PROMPT, wavSeconds } from './cloudTranscriber';
import { TsukuyomiManager } from './manager';
import { whisperPaths } from './transcriber';

/**
 * M42-7(TUKU-yomi): 耳のクラウド文字起こし。
 *
 * **鉄則2(音声はAPIに送らない)を勇太さんの承認で変更した**(2026-07-12)。
 * だからこそ、ここで固定するのは「送るのはクラウドモードの時だけ」「上限を超えたら送らない」
 * 「ローカルモードでは絶対に外に出ない」の3点。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-cloud-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function placeWhisper(): void {
  const paths = whisperPaths(dir);
  mkdirSync(join(dir, 'tsukuyomi', 'models'), { recursive: true });
  writeFileSync(paths.bin, 'dummy');
  writeFileSync(paths.model, 'dummy');
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
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      };
    },
  };
}

/** 16kHz mono 16bit の WAV(ヘッダだけ本物にする。中身は無音) */
function fakeWav(seconds: number): Buffer {
  const byteRate = 16000 * 2;
  const data = Buffer.alloc(Math.round(byteRate * seconds));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(byteRate, 28);
  header.write('data', 36);
  return Buffer.concat([header, data]);
}

function manager(
  cfg: Partial<AppConfig['tsukuyomi']>,
  cloudStt: (() => ReturnType<typeof vi.fn>) | null,
  whisperRunner?: () => Promise<string>,
): TsukuyomiManager {
  return new TsukuyomiManager({
    userDataDir: dir,
    getConfig: () => ({ tsukuyomi: { enabled: true, ears: true, ...cfg } }) as AppConfig,
    hasOwnerKey: () => true,
    emit: () => {},
    visionProvider: () => fakeProvider('[]'),
    ...(cloudStt !== null ? { cloudStt: () => cloudStt() } : {}),
    ...(whisperRunner !== undefined ? { whisperRunner } : {}),
  });
}

describe('M42-7(TUKU-yomi) 耳: クラウド文字起こし', () => {
  it('WAVの秒数をヘッダから数える(上限は「送った音声の長さ」で数えるので、ここが狂うと上限が無意味)', () => {
    expect(Math.round(wavSeconds(fakeWav(3)))).toBe(3);
    expect(wavSeconds(Buffer.alloc(10))).toBe(0); // 壊れた入力
  });

  it('local モードでは**クラウドに一切送らない**(ローカルwhisperだけを通る)', async () => {
    placeWhisper();
    const cloud = vi.fn(async () => 'クラウドが答えた');
    const m = manager({ sttMode: 'local' }, () => cloud, async () => 'ローカルが答えた\n');

    await m.transcribeAndExtract(fakeWav(2));
    expect(cloud).not.toHaveBeenCalled();
    expect(m.status().sttMode).toBe('local');
  });

  it('cloud モードでは whisper 未配置でも文字起こしできる(ローカルに依存しない)', async () => {
    const cloud = vi.fn(async () => '明日の13時にレビューをやる');
    const m = manager({ sttMode: 'cloud' }, () => cloud);

    const { items, error } = await m.transcribeAndExtract(fakeWav(2));
    expect(error).toBeUndefined();
    expect(cloud).toHaveBeenCalledTimes(1);
    expect(items).toEqual([]); // 抽出は偽プロバイダが [] を返す
    expect(m.status().sttMode).toBe('cloud');
  });

  it('APIキーが無ければ、ローカルに黙って落ちたりしない(エラーを出して止まる)', async () => {
    const m = manager({ sttMode: 'cloud' }, () => vi.fn() as never);
    // cloudStt が null(キー無し)を返すケース
    const noKey = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () => ({ tsukuyomi: { enabled: true, ears: true, sttMode: 'cloud' } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: () => {},
      cloudStt: () => null,
    });
    const { error } = await noKey.transcribeAndExtract(fakeWav(1));
    expect(error).toContain('APIキーが未設定');
    expect(m.status().sttMode).toBe('cloud');
  });

  it('1日の分数上限を超える発話は**送らずに捨てる**(青天井にしない)', async () => {
    const cloud = vi.fn(async () => 'ok');
    const m = manager({ sttMode: 'cloud', cloudMinutesPerDay: 1 }, () => cloud);

    await m.transcribeAndExtract(fakeWav(40)); // 40秒 → 通る(残り20秒)
    expect(m.status().sttMinutesLeft).toBe(0);

    const { error } = await m.transcribeAndExtract(fakeWav(30)); // 30秒 → 残り20秒では送れない
    expect(error).toContain('上限');
    expect(cloud).toHaveBeenCalledTimes(1); // 2件目は**送っていない**
  });

  it('使うモデルは日本語の数字・時刻に強い方(実機で「13時」が「13日」に化けた)', () => {
    expect(CLOUD_STT_MODEL).toBe('gpt-4o-mini-transcribe');
  });

  /** 実機: 呼びかけの「つくよみ」が「月曜日」になり、呼んでも反応しなかった */
  it('語彙ヒントで固有名詞を教える', () => {
    expect(STT_PROMPT).toContain('アマテラス');
    expect(STT_PROMPT).toContain('つくよみ');
  });

  /**
   * 実機: 無音を送ったら**語彙ヒントの文章がそのまま文字起こしとして返ってきた**。
   * ヒントには呼びかけ(「アマテラス」)が入っているので、通すと月読が勝手に返事を始める
   */
  it('語彙ヒントのオウム返しは文字起こしとして扱わない', async () => {
    expect(isPromptEcho(STT_PROMPT)).toBe(true);
    expect(isPromptEcho('アマテラス、つくよみ、月読')).toBe(true);
    expect(isPromptEcho('アマテラス、明日の予定は?')).toBe(false); // 用件があるので本物
    expect(isPromptEcho('')).toBe(false);

    const cloud = vi.fn(async () => STT_PROMPT);
    const m = manager({ sttMode: 'cloud', conversation: true, voiceOutput: true }, () => cloud);
    const r = await m.transcribeAndExtract(fakeWav(1), 'ears');
    expect(r.reply).toBeUndefined(); // ヒントのオウム返しに返事をしない
  });

  /**
   * 実機: 押して話すと常時聴取が**同じ声**を拾い、1回の発話から候補が2つできた。
   * renderer 側は PTT 中に聴取を止めるが、切り替わりの隙間もあるので main 側でも弾く
   */
  it('同じ文字起こしが短時間に2回来たら二重取りとみなして捨てる', async () => {
    const cloud = vi.fn(async () => '明日の13時にレビューをやる');
    const m = manager({ sttMode: 'cloud' }, () => cloud);

    const first = await m.transcribeAndExtract(fakeWav(2));
    expect(first.error).toBeUndefined();

    const second = await m.transcribeAndExtract(fakeWav(2));
    expect(second.error).toContain('もう一度拾った');
    expect(second.items).toEqual([]);
  });
});
