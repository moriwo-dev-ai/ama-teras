// main / renderer 双方から参照する型。ロジックは置かない。

export type AgentStatus =
  | 'idle'
  | 'calling_llm'
  | 'awaiting_approval'
  | 'executing_tool'
  | 'done'
  | 'cancelled'
  | 'error'
  | 'max_turns_reached';

/** main → renderer へ push されるエージェント進行イベント */
export type AgentEvent =
  | { kind: 'status'; sessionId: string; status: AgentStatus }
  | { kind: 'text_delta'; sessionId: string; text: string }
  | { kind: 'message_done'; sessionId: string }
  | { kind: 'error'; sessionId: string; message: string };
