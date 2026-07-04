import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  EvolutionEvent,
  SubAgentUpdate,
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
}

export type BusChannel = keyof BusEventMap;

export const BUS_CHANNELS: readonly BusChannel[] = [
  'chat:event',
  'approval:request',
  'approval:resolved',
  'evolution:event',
  'agent:sub_update',
] as const;

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
