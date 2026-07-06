import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * M20: 再起動センチネル(クラッシュ検知)。聖域(src/main/evolution)内。
 *
 * プロトコル:
 * 1. 昇格→再起動の直前に旧インスタンスが {tag, prevCommit, bootAttempts:0} を書く
 * 2. 新インスタンスは起動開始時に bootAttempts を +1 して書き戻す(「今から起動を試みる」宣言。
 *    起動が完走できなければこのインクリメントが墓標として残る=クラッシュ検知の要)
 * 3. 起動が完走(IPC配線+ウィンドウ表示)したらセンチネルを削除(=健全)
 * 4. 起動開始時に bootAttempts >= 2 を読んだ(=2回連続で完走前に死んだ)→ セーフモード:
 *    進化機能を無効化して起動し、ユーザーに復旧手順(prevCommit)を提示する。
 *    センチネルは削除しない(ユーザーが明示的に解除するまでセーフモード継続)
 *
 * 限界(設計判断・ユーザー承認済み): mainバンドル自体がパース不能なほど壊れている場合は
 * このコードも走らない。それは手前の二重ゲート(B内smoke-boot+A内健全性チェック)で防ぎ、
 * 最終復旧は手動(git reset --hard <prevCommit> && npm run build)。外部watchdogは範囲外
 */

export const SENTINEL_FILENAME = 'restart-sentinel.json';

export interface RestartSentinel {
  /** 昇格タグ(evolve/N) */
  tag: string;
  /** 昇格前のHEAD(セーフモード時の手動復旧案内に使う) */
  prevCommit: string;
  /** 起動試行回数(完走で削除されるため、残っている=未完走) */
  bootAttempts: number;
  writtenAt: string;
}

function sentinelPath(userDataDir: string): string {
  return join(userDataDir, SENTINEL_FILENAME);
}

export function readSentinel(userDataDir: string): RestartSentinel | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(sentinelPath(userDataDir), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec['tag'] !== 'string' || typeof rec['bootAttempts'] !== 'number') return null;
    return {
      tag: rec['tag'],
      prevCommit: typeof rec['prevCommit'] === 'string' ? rec['prevCommit'] : '',
      bootAttempts: rec['bootAttempts'],
      writtenAt: typeof rec['writtenAt'] === 'string' ? rec['writtenAt'] : '',
    };
  } catch {
    return null;
  }
}

/** 再起動の直前(旧インスタンス)に書く */
export function writeSentinel(userDataDir: string, tag: string, prevCommit: string): void {
  mkdirSync(userDataDir, { recursive: true });
  const data: RestartSentinel = { tag, prevCommit, bootAttempts: 0, writtenAt: new Date().toISOString() };
  writeFileSync(sentinelPath(userDataDir), JSON.stringify(data, null, 2), 'utf8');
}

export interface BootSentinelState {
  /** 進化再起動の途中だった(通知用)。センチネルが無ければ null */
  sentinel: RestartSentinel | null;
  /** 2回連続クラッシュを検知 → 進化機能を止めて起動すべき */
  safeMode: boolean;
}

/**
 * 起動開始時に呼ぶ(IPC配線より前)。
 * bootAttempts>=2(=2回連続で完走前に死んだ)ならセーフモード。
 * それ以外は attempts を加算して書き戻す(完走時に markBootHealthy で削除)
 */
export function beginBootWithSentinel(userDataDir: string): BootSentinelState {
  const sentinel = readSentinel(userDataDir);
  if (sentinel === null) return { sentinel: null, safeMode: false };
  if (sentinel.bootAttempts >= 2) {
    // セーフモード: 加算も削除もしない(解除はユーザー操作)
    return { sentinel, safeMode: true };
  }
  const next: RestartSentinel = { ...sentinel, bootAttempts: sentinel.bootAttempts + 1 };
  writeFileSync(sentinelPath(userDataDir), JSON.stringify(next, null, 2), 'utf8');
  return { sentinel: next, safeMode: false };
}

/** 起動完走時に呼ぶ。センチネルがあれば削除して返す(「再起動完了」通知用) */
export function markBootHealthy(userDataDir: string): RestartSentinel | null {
  const sentinel = readSentinel(userDataDir);
  if (sentinel === null) return null;
  rmSync(sentinelPath(userDataDir), { force: true });
  return sentinel;
}

/** セーフモードの手動解除(Settings から) */
export function clearSentinel(userDataDir: string): boolean {
  if (!existsSync(sentinelPath(userDataDir))) return false;
  rmSync(sentinelPath(userDataDir), { force: true });
  return true;
}
