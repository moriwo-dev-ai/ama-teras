import { useEffect } from 'react';
import { ChatView } from './components/Chat/ChatView';
import { useChatStore } from './stores/chat';

export default function App(): JSX.Element {
  const handleEvent = useChatStore((s) => s.handleEvent);

  useEffect(() => window.api.onChatEvent(handleEvent), [handleEvent]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-700 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide">MyCodex</h1>
        <span className="text-xs text-zinc-400">自己進化型コーディングエージェント</span>
      </header>
      <ChatView />
    </div>
  );
}
