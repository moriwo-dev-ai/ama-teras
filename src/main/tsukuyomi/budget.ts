import type { TsukuyomiConfig } from '../../shared/types';
import { TSUKUYOMI_DEFAULTS } from '../config';

/**
 * M42(TUKU-yomi): 割り込み予算とフレーム送信上限。
 *
 * 月読の価値は賢さではなく「黙るべき時を知っている」こと(鉄則3)。
 * 自発的な発話は1日N回まで+静音時間は喋らない。ユーザーが押したボタンは予算の対象外。
 * 映像理解のAPI送信も同じ思想で上限を持つ(鉄則11。時間・日の二重上限)。
 *
 * すべて純関数。状態は呼び出し側(manager)が持ち、state.json に保存する。
 */

export interface TsukuyomiState {
  /** 'YYYY-MM-DD'(ローカル日付)。日が変わったらカウンタを畳む */
  day: string;
  /** 今日すでに自発的に喋った回数 */
  interruptsSpent: number;
  /** 今日すでにAPIへ送ったフレーム数 */
  framesSpentToday: number;
  /** 直近1時間に送ったフレームの送信時刻(ISO)。1時間より古いものは捨てる */
  frameTimesThisHour: string[];
}

export function emptyState(now: Date): TsukuyomiState {
  return { day: dayKey(now), interruptsSpent: 0, framesSpentToday: 0, frameTimesThisHour: [] };
}

/** ローカル日付のキー(UTCではない。生活の1日で畳む) */
export function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日が変わっていたらカウンタを畳む(状態は必ずこれを通してから読む) */
export function resetIfNewDay(state: TsukuyomiState, now: Date): TsukuyomiState {
  const today = dayKey(now);
  if (state.day === today) return state;
  return { day: today, interruptsSpent: 0, framesSpentToday: 0, frameTimesThisHour: [] };
}

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 静音時間の判定。**日付を跨ぐ範囲(23:00→07:00)を正しく扱う**。
 * start === end は「静音なし」として扱う(24時間黙る設定は事故なので受け付けない)
 */
export function isQuietHour(now: Date, cfg: TsukuyomiConfig): boolean {
  const q = cfg.quietHours ?? TSUKUYOMI_DEFAULTS.quietHours;
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === null || end === null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  // 跨がない範囲(例 01:00-05:00)は素直に間、跨ぐ範囲(23:00-07:00)は外側が静音
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export function interruptsLeft(state: TsukuyomiState, cfg: TsukuyomiConfig, now: Date): number {
  const s = resetIfNewDay(state, now);
  const budget = cfg.interruptBudgetPerDay ?? TSUKUYOMI_DEFAULTS.interruptBudgetPerDay;
  return Math.max(0, budget - s.interruptsSpent);
}

/** 自発的に喋ってよいか。静音時間・予算切れなら黙る(ユーザー起点の発話はこれを通さない) */
export function canInterrupt(state: TsukuyomiState, cfg: TsukuyomiConfig, now: Date): boolean {
  if (isQuietHour(now, cfg)) return false;
  return interruptsLeft(state, cfg, now) > 0;
}

/** 発話1回分を消費した新しい状態を返す(呼び出し側が保存する) */
export function spend(state: TsukuyomiState, now: Date): TsukuyomiState {
  const s = resetIfNewDay(state, now);
  return { ...s, interruptsSpent: s.interruptsSpent + 1 };
}

/** 直近1時間の送信だけを残す(時間窓は滑走窓。時計の切れ目に依存しない) */
function recentFrames(state: TsukuyomiState, now: Date): string[] {
  const limit = now.getTime() - 60 * 60 * 1000;
  return state.frameTimesThisHour.filter((t) => Date.parse(t) >= limit);
}

export function framesLeftThisHour(state: TsukuyomiState, cfg: TsukuyomiConfig, now: Date): number {
  const s = resetIfNewDay(state, now);
  const perHour = cfg.framesPerHour ?? TSUKUYOMI_DEFAULTS.framesPerHour;
  return Math.max(0, perHour - recentFrames(s, now).length);
}

export function framesLeftToday(state: TsukuyomiState, cfg: TsukuyomiConfig, now: Date): number {
  const s = resetIfNewDay(state, now);
  const perDay = cfg.framesPerDay ?? TSUKUYOMI_DEFAULTS.framesPerDay;
  return Math.max(0, perDay - s.framesSpentToday);
}

/** 映像理解のためにフレームをAPIへ送ってよいか(時間・日の二重上限) */
export function canSendFrame(state: TsukuyomiState, cfg: TsukuyomiConfig, now: Date): boolean {
  return framesLeftThisHour(state, cfg, now) > 0 && framesLeftToday(state, cfg, now) > 0;
}

/** フレーム1枚分を消費した新しい状態を返す */
export function spendFrame(state: TsukuyomiState, now: Date): TsukuyomiState {
  const s = resetIfNewDay(state, now);
  return {
    ...s,
    framesSpentToday: s.framesSpentToday + 1,
    frameTimesThisHour: [...recentFrames(s, now), now.toISOString()],
  };
}
