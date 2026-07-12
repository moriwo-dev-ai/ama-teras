import { useEffect, useState } from 'react';
import type { ChoEntry } from '../../../../shared/types';
import { useTsukuyomiStore } from '../../stores/tsukuyomi';

/**
 * M42(TUKU-yomi): 月読タブ。
 *
 * 太陽が「作る」なら月は「覚えている」。ここに出るのは**抽出された一文だけ**で、
 * 生ログ(音声・映像)は残らない。observation は7日で忘れる。
 * TUKU-yomi の出力は「発話」と「この帳」の2つだけ — チャット欄に文章で割り込まない。
 */

const KIND_LABEL: Record<ChoEntry['kind'], string> = {
  promise: '約束',
  decision: '決定',
  todo: 'ToDo',
  observation: '観察',
};

const KIND_STYLE: Record<ChoEntry['kind'], string> = {
  promise: 'bg-indigo-900 text-indigo-200',
  decision: 'bg-emerald-900 text-emerald-200',
  todo: 'bg-amber-900 text-amber-200',
  observation: 'bg-zinc-800 text-zinc-400',
};

const SOURCE_LABEL: Record<ChoEntry['source'], string> = {
  chat: '会話',
  voice: '声',
  camera: '目',
  pc: 'PC',
  manual: '手入力',
};

export function TsukuyomiPanel(): JSX.Element {
  const status = useTsukuyomiStore((s) => s.status);
  const entries = useTsukuyomiStore((s) => s.entries);
  const refresh = useTsukuyomiStore((s) => s.refresh);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ChoEntry['kind']>('todo');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = entries.filter((e) => e.kind !== 'observation' && e.done !== true);
  const done = entries.filter((e) => e.kind !== 'observation' && e.done === true);
  const observations = entries.filter((e) => e.kind === 'observation');

  return (
    <div className="space-y-3 p-3 text-sm">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-indigo-300">
          🌙 月読 — 記憶の義手
        </h2>
        <p className="mt-0.5 text-[10px] text-zinc-500">
          あなた自身の約束・決定・ToDoを覚えておく。生の音声・映像は残さない(観察は7日で忘れる)
        </p>
      </div>

      {/* 予算: 「黙るべき時を知っている」ことが月読の価値。残量を常に見せる */}
      {status !== null && (
        <div className="flex flex-wrap gap-2 text-[10px] text-zinc-400">
          <span className="rounded border border-zinc-800 px-2 py-0.5">
            今日の声かけ残り {status.interruptsLeft} 回
          </span>
          <span className="rounded border border-zinc-800 px-2 py-0.5">
            映像理解 残り {status.framesLeftThisHour}/時 ・ {status.framesLeftToday}/日
          </span>
          {status.quiet && <span className="rounded border border-indigo-900 px-2 py-0.5 text-indigo-300">静音時間(黙る)</span>}
          {status.voiceOutput && (
            <button
              className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800"
              onClick={() => {
                void window.api
                  .tsukuyomiSpeak('月読です。聞こえていますか')
                  .then((ok) => setNotice(ok ? '喋りました' : '口がOFFです'));
              }}
            >
              🔈 試しに喋る(予算を使わない)
            </button>
          )}
        </div>
      )}

      {/* 手入力(自動記入は後続Stage。まずは人が書ける) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[11px]"
          value={kind}
          onChange={(e) => setKind(e.target.value as ChoEntry['kind'])}
        >
          {(['todo', 'promise', 'decision'] as const).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
          placeholder="覚えておいてほしいこと(例: 明日13時にレビューをやると伝えた)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || text.trim() === '') return;
            void window.api
              .tsukuyomiAdd({ kind, text: text.trim(), source: 'manual' })
              .then(() => {
                setText('');
                return refresh();
              });
          }}
        />
        <button
          className="rounded border border-indigo-800 px-2 py-1 text-[11px] text-indigo-300 hover:bg-indigo-950 disabled:opacity-40"
          disabled={text.trim() === ''}
          onClick={() => {
            void window.api
              .tsukuyomiAdd({ kind, text: text.trim(), source: 'manual' })
              .then(() => {
                setText('');
                return refresh();
              });
          }}
        >
          帳に書く
        </button>
      </div>
      {notice !== null && <p className="text-[10px] text-zinc-400">{notice}</p>}

      <ChoList title="覚えていること" entries={open} onChange={refresh} />
      {done.length > 0 && <ChoList title="済んだこと" entries={done} onChange={refresh} dim />}
      {observations.length > 0 && (
        <ChoList title="観察(7日で忘れる)" entries={observations} onChange={refresh} dim />
      )}
      {entries.length === 0 && (
        <p className="text-[11px] text-zinc-500">
          まだ何も覚えていません。上の欄に書くか、目・耳をONにすると自動で溜まります
        </p>
      )}
    </div>
  );
}

function ChoList({
  title,
  entries,
  onChange,
  dim,
}: {
  title: string;
  entries: ChoEntry[];
  onChange: () => Promise<void>;
  dim?: boolean;
}): JSX.Element {
  return (
    <div className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">{title}</h3>
      {entries.map((e) => (
        <div
          key={e.id}
          className={`flex items-start gap-2 rounded border border-zinc-800 bg-zinc-950 p-2 text-xs ${dim === true ? 'opacity-60' : ''}`}
        >
          {e.kind !== 'observation' && (
            <input
              type="checkbox"
              className="mt-0.5"
              checked={e.done === true}
              onChange={(ev) => {
                void window.api.tsukuyomiSetDone(e.id, ev.target.checked).then(() => onChange());
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${KIND_STYLE[e.kind]}`}>{KIND_LABEL[e.kind]}</span>
              <span className="text-[10px] text-zinc-500">
                {e.ts.slice(5, 16).replace('T', ' ')} / {SOURCE_LABEL[e.source]}
              </span>
              {e.due !== undefined && <span className="text-[10px] text-amber-400">期限 {e.due.slice(0, 16).replace('T', ' ')}</span>}
            </div>
            <p className={`mt-0.5 whitespace-pre-wrap text-zinc-200 ${e.done === true ? 'line-through' : ''}`}>{e.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
