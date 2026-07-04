import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../shared/types';
import { BUS_CHANNELS, EventBus } from './events';

const chatEvent: AgentEvent = { kind: 'status', sessionId: 's1', status: 'calling_llm' };

describe('EventBus', () => {
  it('publish したイベントが購読者へ届く', () => {
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    bus.subscribe('chat:event', (e) => seen.push(e));
    bus.publish('chat:event', chatEvent);
    expect(seen).toEqual([chatEvent]);
  });

  it('購読解除後は届かない', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsub = bus.subscribe('chat:event', listener);
    unsub();
    bus.publish('chat:event', chatEvent);
    expect(listener).not.toHaveBeenCalled();
  });

  it('チャネルが違うイベントは届かない', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe('evolution:event', listener);
    bus.publish('chat:event', chatEvent);
    expect(listener).not.toHaveBeenCalled();
  });

  it('subscribeAll は全チャネルを受け、解除で全部止まる', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsub = bus.subscribeAll((channel) => seen.push(channel));
    bus.publish('chat:event', chatEvent);
    bus.publish('approval:request', {
      id: 'a1',
      toolName: 'bash',
      risk: 'exec',
      inputPreview: '{}',
      warnings: [],
    });
    bus.publish('approval:resolved', { id: 'a1', decision: 'allow' });
    bus.publish('evolution:event', {
      kind: 'job_update',
      job: { id: 1, description: 'd', status: 'queued', log: [], gates: [] },
    });
    bus.publish('agent:sub_update', { id: 1, task: 't', mode: 'work', status: 'running' });
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(BUS_CHANNELS));
    unsub();
    bus.publish('chat:event', chatEvent);
    expect(seen.length).toBe(5);
  });
});
