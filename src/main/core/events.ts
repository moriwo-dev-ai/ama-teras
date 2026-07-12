import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  AutonomousStatePayload,
  EvolutionEvent,
  RunInfo,
  SubAgentUpdate,
  TsukuyomiEvent,
} from '../../shared/types';

/**
 * M10-1: main プロセス内のイベントバス。エージェントの進行イベントを
 * IPC(webContents.send)とリモートサーバ(SSE)の両方へ配るための一段抽象化。
 * チャネル名は既存の IPC チャネル名と一致させている(受け手側の写像を単純にするため)。
 */
export interface BusEventMap {
  'chat:event': AgentEvent;
  'approval:request': ApprovalRequestPayload;
  'approval:resolved': ApprovalResolvedPayload;
  'evolution:event': EvolutionEvent;
  /** M12-3: 並列サブエージェントの進行状況 */
  'agent:sub_update': SubAgentUpdate;
  /** M17-2: 自律モードの ON/OFF 変更(全画面の警告バー・トグル同期用) */
  'autonomous:changed': AutonomousStatePayload;
  /** M22: 実行中ラン一覧の変化(開始/終了のたびに全量を配る) */
  'runs:changed': RunInfo[];
  /**
   * M42(TUKU-yomi): 月読の通知(発話・帳の変化・現況)。
   * **remote-ui(スマホ)へは中継しない**(鉄則4: 発話内容・帳がスマホへ漏れる経路を作らない)。
   * そのため BUS_CHANNELS(=SSE中継の対象)には入れない
   */
  'tsukuyomi:event': TsukuyomiEvent;
}

export type BusChannel = keyof BusEventMap;

/**
 * SSE(remote-ui)へ中継するチャネル。**ここに載っているものだけがスマホへ届く**。
 * 'tsukuyomi:event' を意図的に含めていない(除外は events.test.ts で固定)
 */
export const BUS_CHANNELS: readonly BusChannel[] = [
  'chat:event',
  'approval:request',
  'approval:resolved',
  'evolution:event',
  'agent:sub_update',
  'autonomous:changed',
  'runs:changed',
] as const;

/** ローカル(デスクトップ)のみに配るチャネル。SSE には絶対に載せない */
export const LOCAL_ONLY_CHANNELS: readonly BusChannel[] = ['tsukuyomi:event'] as const;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // SSE接続ごとに全チャネルを購読するため、既定の10リスナー警告を外す
    this.emitter.setMaxListeners(0);
  }

  publish<C extends BusChannel>(channel: C, payload: BusEventMap[C]): void {
    this.emitter.emit(channel, payload);
  }

  /** 戻り値は購読解除関数 */
  subscribe<C extends BusChannel>(
    channel: C,
    listener: (payload: BusEventMap[C]) => void,
  ): () => void {
    const wrapped = (payload: BusEventMap[C]): void => listener(payload);
    this.emitter.on(channel, wrapped);
    return () => {
      this.emitter.off(channel, wrapped);
    };
  }

  /** 全チャネル一括購読(SSE 中継用)。戻り値は購読解除関数 */
  subscribeAll(
    listener: (channel: BusChannel, payload: BusEventMap[BusChannel]) => void,
  ): () => void {
    const unsubs = BUS_CHANNELS.map((ch) => this.subscribe(ch, (p) => listener(ch, p)));
    return () => {
      for (const u of unsubs) u();
    };
  }
}
