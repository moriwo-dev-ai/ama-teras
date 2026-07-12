import { useEffect, useRef } from 'react';
import type { TalkEntry } from '../../../../shared/types';
import { useTsukuyomiStore } from '../../stores/tsukuyomi';
import { useTsukuyomiThreadStore } from '../../stores/tsukuyomiThread';

/**
 * M43-2(TUKU-yomi): 月読との会話履歴(⛩運営スレッドと同じ流儀でメイン領域に出す)。
 *
 * ここには**生の発話**が残る(帳は承認済みの記録だけ、こちらは言った言葉そのもの)。
 * 残す物は消せなければならないので「全部消す」を必ず置く。
 */

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Bubble({ talk }: { talk: TalkEntry }): JSX.Element {
  if (talk.role === 'action') {
    return (
      <div className="mx-auto max-w-[80%] rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
        ⚙ {talk.text}
        <span className="ml-2 text-[10px] text-amber-500/70">{timeOf(talk.ts)}</span>
      </div>
    );
  }
  const mine = talk.role === 'you';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded px-2.5 py-1.5 text-xs ${
          mine ? 'bg-zinc-800 text-zinc-100' : 'border border-indigo-900 bg-indigo-950/50 text-indigo-100'
        }`}
      >
        {!mine && <span className="mr-1">🌙</span>}
        {talk.text}
        <div className="mt-0.5 text-[10px] text-zinc-500">{timeOf(talk.ts)}</div>
      </div>
    </div>
  );
}

export function TsukuyomiThreadPanel(): JSX.Element {
  const talks = useTsukuyomiThreadStore((s) => s.talks);
  const refreshTalks = useTsukuyomiThreadStore((s) => s.refreshTalks);
  const clear = useTsukuyomiThreadStore((s) => s.clear);
  const status = useTsukuyomiStore((s) => s.status);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshTalks();
  }, [refreshTalks]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [talks.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div>
          <h2 className="text-sm text-indigo-200">🌙 TUKU-yomi</h2>
          <p className="text-[10px] text-zinc-500">
            話した内容と、月読がやったことの履歴。
            {status?.sttMode === 'cloud'
              ? '文字起こしはクラウド(OpenAI)。'
              : '文字起こしはこのPCの中。'}
            この履歴はこのPCの中だけに残ります(スマホには出ません)
          </p>
        </div>
        <button
          className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
          onClick={() => void clear()}
        >
          全部消す
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {talks.length === 0 ? (
          <p className="text-xs text-zinc-500">
            まだ会話がありません。月読タブの「🎤 押している間だけ録音」で話しかけてください
            {status?.conversation === false && '(設定の「会話」をONにすると声で返します)'}
          </p>
        ) : (
          talks.map((t) => <Bubble key={t.id} talk={t} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
