import { useEffect, useRef, useState } from 'react';
import type { ChatImageInput } from '../../../../shared/types';
import { useChatStore, type UiMessage } from '../../stores/chat';
import { usePreviewStore } from '../../stores/preview';
import { revealContextMenuHandler } from '../../stores/revealMenu';
import { AutonomousModal } from './AutonomousModal';
import { MarkdownMessage } from './MarkdownMessage';
import { InventoryCard } from './InventoryCard';
import { ReviewCard } from './ReviewCard';
import { formatElapsed, useNowTick } from './useElapsed';
import { DEFAULT_MODELS, PROVIDER_PRESETS } from '../../../../shared/models';
import { useRunsStore } from '../../stores/runs';

/** ツール入力JSONから path を取り出す(write_file/read_file/edit_file等のリンク化用) */
function pathFromInputPreview(inputPreview: string): string | null {
  const m = /"path"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(inputPreview);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return null;
  }
}

/** M14-2: File → base64 添付(データURLのプレフィックスを剥がす) */
async function fileToAttachment(file: File): Promise<ChatImageInput | null> {
  if (!file.type.startsWith('image/')) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('読み込み失敗'));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  return { mediaType: file.type, data: dataUrl.slice(comma + 1), description: file.name || 'pasted-image' };
}

function ToolCard({ msg }: { msg: Extract<UiMessage, { role: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const openPreview = usePreviewStore((s) => s.open);
  const path = pathFromInputPreview(msg.inputPreview);
  // M21-4: 実行中の経過時間+無応答検知(最後のライブ出力 or 開始から30秒で⏳)
  const now = useNowTick(msg.running);
  const lastSignalAt = msg.progressAt ?? msg.startedAt ?? 0;
  const silentSec = msg.running && lastSignalAt > 0 ? Math.floor((now - lastSignalAt) / 1000) : 0;
  return (
    <div className="anim-appear flex justify-start">
      <div
        className={`max-w-[85%] rounded-md border px-3 py-1.5 text-xs ${
          msg.isError ? 'border-red-700 bg-red-950' : 'border-zinc-700 bg-zinc-900'
        }`}
      >
        <button
          className="flex items-center gap-2 text-zinc-300"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="font-mono text-blue-300">{msg.name}</span>
          <span className="max-w-[360px] truncate text-zinc-500">{msg.inputPreview}</span>
          {msg.images && msg.images.length > 0 && <span>🖼</span>}
          {msg.running && (
            <span className="flex items-center gap-1 text-zinc-400">
              <span className="anim-spin">◌</span>
              <span className="anim-pulse">実行中</span>
              {msg.startedAt !== undefined && (
                <span className="font-mono text-zinc-500">{formatElapsed(now - msg.startedAt)}</span>
              )}
              {silentSec >= 30 && (
                <span className="text-amber-300" title="出力が途絶えているが実行は継続中(killしない)">
                  ⏳無応答{silentSec}s
                </span>
              )}
            </span>
          )}
          {!msg.running && <span className="text-zinc-500">{open ? '▲' : '▼'}</span>}
        </button>
        {/* M21-4: 実行中のライブ出力末尾(bash等) */}
        {msg.running && msg.progressTail && (
          <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap border-t border-zinc-800 pt-1 font-mono text-[10px] text-zinc-500">
            {msg.progressTail}
          </pre>
        )}
        {path && (
          <button
            className="mt-0.5 block truncate font-mono text-[11px] text-blue-300 underline decoration-dotted hover:text-blue-200"
            title={`${path} をプレビュー(右クリック: フォルダで開く)`}
            onClick={() => void openPreview(path)}
            onContextMenu={revealContextMenuHandler(path)}
          >
            📄 {path}
          </button>
        )}
        {msg.images && msg.images.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {msg.images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt="ツール結果画像"
                className="max-h-48 max-w-[320px] rounded border border-zinc-700 object-contain"
              />
            ))}
          </div>
        )}
        {open && msg.resultContent && (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border-t border-zinc-700 pt-1 text-zinc-400">
            {msg.resultContent}
          </pre>
        )}
      </div>
    </div>
  );
}

/** M21-4: 受領指示の直下に出す「現在の状況」ライン(スピナー+経過+最新思考のライブ表示) */
function LiveStatusLine(): JSX.Element {
  const { status, narration, runStartedAt, messages } = useChatStore();
  const now = useNowTick(true);
  const runningTool = [...messages].reverse().find((m) => m.role === 'tool' && m.running);
  const label =
    status === 'calling_llm' ? 'モデル応答中' : status === 'executing_tool' ? 'ツール実行中' : '実行中';
  // 思考の末尾1行だけ(改行を潰して詰める)
  const tail = narration.replace(/\s+/g, ' ').trim().slice(-120);
  return (
    <div className="anim-fade flex justify-start">
      <div className="max-w-[85%] rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-[11px] text-zinc-400">
        <span className="anim-spin mr-1 text-blue-300">◌</span>
        <span className="text-zinc-300">{label}</span>
        {runStartedAt !== null && (
          <span className="ml-1 font-mono text-zinc-500">{formatElapsed(now - runStartedAt)}</span>
        )}
        {runningTool && runningTool.role === 'tool' && (
          <span className="ml-2 font-mono text-zinc-500">⚙ {runningTool.name}</span>
        )}
        {tail !== '' && (
          <div className="mt-0.5 text-zinc-500">
            <span className="text-zinc-600">現在の状況: </span>
            {tail}
          </div>
        )}
      </div>
    </div>
  );
}

/** M21-4: 入力欄上の常時ステータス(スクロール位置に関係なく生存が見える)。M23: 実行中モデルも表示 */
function BottomStatus({ status }: { status: string }): JSX.Element {
  const runStartedAt = useChatStore((s) => s.runStartedAt);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const runModel = useRunsStore((s) => s.runs.find((r) => r.sessionId === activeSessionId)?.model);
  const now = useNowTick(true);
  return (
    <p className="mb-1 flex items-center gap-1.5 text-xs text-zinc-500">
      <span className="anim-spin text-blue-300">◌</span>
      状態: {status === 'calling_llm' ? 'モデル応答中' : status === 'executing_tool' ? 'ツール実行中' : status}
      {runStartedAt !== null && <span className="font-mono">{formatElapsed(now - runStartedAt)}</span>}
      {runModel !== undefined && <span className="font-mono text-zinc-600">{runModel}</span>}
    </p>
  );
}

export function ChatView(): JSX.Element {
  const { messages, status, activeSessionId, send, cancel } = useChatStore();
  const [input, setInput] = useState('');
  const [planMode, setPlanMode] = useState(false);
  const [attachments, setAttachments] = useState<ChatImageInput[]>([]);
  // M17-2: 自律モード(main側が正。イベントで同期し、ON操作は警告モーダルを必須にする)
  const [autonomous, setAutonomous] = useState(false);
  const [autoModal, setAutoModal] = useState(false);
  // M18/M23: メイン応答のモデルバッジ(policy有効=planner帯・無効=本体設定のモデル)
  const [policyOn, setPolicyOn] = useState(false);
  const [mainModel, setMainModel] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = activeSessionId !== null;

  useEffect(() => {
    window.api
      .autonomousGet()
      .then((r) => setAutonomous(r.on))
      .catch(() => {});
    return window.api.onAutonomousChanged((p) => setAutonomous(p.on));
  }, []);

  // 設定変更(Settingsを閉じた後)を拾えるよう、アイドル復帰のたびに読み直す
  useEffect(() => {
    if (busy) return;
    window.api
      .settingsGet()
      .then((c) => {
        // M96: freeMode中はpolicyが実行側で無効化される(effectiveModelPolicy)。バッジも同じ規則で判定
        const on = c.modelPolicy?.enabled === true && c.freeMode !== true;
        setPolicyOn(on);
        // M23/M96: 実際に使うモデル名。プリセット使用中はプリセットの既定を表示
        // (以前は空モデル時に DEFAULT_MODELS[provider] を出し、Kimi実行中に gpt-5.6-sol と表示していた)
        const preset = c.provider === 'openai' && c.providerPreset ? PROVIDER_PRESETS[c.providerPreset] : undefined;
        setMainModel(
          on && c.modelPolicy
            ? c.modelPolicy.planner.model || DEFAULT_MODELS[c.modelPolicy.planner.provider]
            : c.model || (preset ? preset.defaultModel : DEFAULT_MODELS[c.provider]),
        );
      })
      .catch(() => {});
  }, [busy]);

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const added: ChatImageInput[] = [];
    for (const f of files) {
      const a = await fileToAttachment(f).catch(() => null);
      if (a) added.push(a);
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added].slice(0, 8));
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = (): void => {
    // M21-1: 実行中も送信可(追加指示としてキューに積まれ、次ターン境界で反映される)
    if (!input.trim() && attachments.length === 0) return;
    void send(input, planMode ? 'plan' : 'normal', attachments.length > 0 ? attachments : undefined);
    setInput('');
    setAttachments([]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {autonomous && (
        <div className="auto-warn-bar flex items-center justify-center gap-3 border-b px-4 py-1.5 text-xs">
          <span>🔓 自律モード有効 — ツールを承認なしで自動実行中(自己責任)</span>
          <button className="auto-warn-off rounded px-2 py-0.5" onClick={() => void window.api.autonomousSet(false)}>
            OFFにする
          </button>
        </div>
      )}
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="mt-16 text-center text-sm text-zinc-500">
            指示を入力するとエージェントが作業を開始します(APIキーは設定パネルから登録)
          </p>
        )}
        {messages.map((m, i) => {
          // M21-4: 受領した指示(最後のuserメッセージ)の直下に「現在の状況」ラインを挟む
          const isLastUser = busy && m.role === 'user' && !messages.slice(i + 1).some((x) => x.role === 'user');
          const liveLine = isLastUser ? <LiveStatusLine key={`${m.id}-live`} /> : null;
          const rendered =
          m.role === 'tool' ? (
            <ToolCard key={m.id} msg={m} />
          ) : m.role === 'review' ? (
            <ReviewCard key={m.id} card={m} />
          ) : m.role === 'inventory' ? (
            <InventoryCard key={m.id} items={m.items} />
          ) : m.role === 'info' ? (
            <div key={m.id} className="anim-appear flex justify-center">
              <div className="max-w-[85%] rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-center text-[11px] text-zinc-400">
                ℹ️ {m.text}
              </div>
            </div>
          ) : (
            <div
              key={m.id}
              className={m.role === 'user' ? 'anim-appear flex justify-end' : 'anim-appear flex justify-start'}
            >
              <div
                className={
                  'max-w-[80%] rounded-lg px-3 py-2 text-sm ' +
                  (m.role === 'user' ? 'whitespace-pre-wrap bg-blue-600 user-msg' : 'bg-zinc-800')
                }
              >
                {m.images && m.images.length > 0 && (
                  <div className="mb-1 flex flex-wrap gap-1">
                    {m.images.map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        alt="添付画像"
                        className="max-h-40 max-w-[240px] rounded border border-blue-400/40 object-contain"
                      />
                    ))}
                  </div>
                )}
                {/* M21-1: 実行中に積まれた追加指示のバッジ */}
                {m.role === 'user' && m.queued && (
                  <div className="mb-0.5 text-[10px] text-blue-200/80">↩ 追加指示(次のターンで反映)</div>
                )}
                {/* M18/M23: メイン応答が使うモデルを明示(policy有効ならplanner帯)。
                    M30-2: クリックでモデル設定を開く(policy有効=モデル運用タブ/無効=基本タブ) */}
                {m.role === 'assistant' && mainModel !== '' && (
                  <button
                    className="mb-0.5 block text-[9px] tracking-wider text-zinc-500 hover:text-zinc-300 hover:underline"
                    title={policyOn ? 'クリックでモデル運用(帯設定)を開く' : 'クリックでモデル設定を開く'}
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('amateras:open-settings', {
                          detail: { tab: policyOn ? 'models' : 'basic' },
                        }),
                      )
                    }
                  >
                    {policyOn ? 'PLANNER・' : ''}
                    {mainModel}
                  </button>
                )}
                {m.role === 'assistant' ? <MarkdownMessage text={m.text} /> : m.text}
                {/* M30-2: モデル未開放エラー等は設定への導線ボタンを付ける */}
                {m.role === 'assistant' && m.settingsHint !== undefined && (
                  <button
                    className="mt-1.5 block rounded border border-amber-700 bg-amber-950/60 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-950"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('amateras:open-settings', { detail: { tab: m.settingsHint } }),
                      )
                    }
                  >
                    ⚙ 設定を開く({m.settingsHint === 'models' ? 'モデル運用' : '基本'}タブ)
                  </button>
                )}
                {m.streaming && <span className="anim-pulse ml-1">▍</span>}
              </div>
            </div>
          );
          return liveLine ? [rendered, liveLine] : rendered;
        })}
        <div ref={bottomRef} />
      </div>
      <div
        className="border-t border-zinc-700 p-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        {busy && <BottomStatus status={status} />}
        <div className="mb-2 flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1 text-zinc-400">
            <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} />
            プランモード(実装前に計画のみ提示・ツール不実行)
          </label>
          <span className="text-zinc-600">画像はドラッグ&ドロップ / ペーストで添付</span>
        </div>
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a, i) => (
              <div key={i} className="relative">
                <img
                  src={`data:${a.mediaType};base64,${a.data}`}
                  alt={a.description ?? '添付画像'}
                  className="h-16 w-16 rounded border border-zinc-700 object-cover"
                />
                <button
                  className="absolute -right-1.5 -top-1.5 h-4 w-4 rounded-full bg-zinc-700 text-[10px] leading-4 hover:bg-red-600"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          {/* M17-2: 自律モードトグル(ONは警告モーダル必須・OFFはワンクリック) */}
          <button
            className={
              'shrink-0 self-end rounded-md border px-2 py-2 text-xs ' +
              (autonomous
                ? 'border-amber-500 bg-amber-900/50 text-amber-200 hover:bg-amber-800'
                : 'border-zinc-600 text-zinc-400 hover:bg-zinc-800')
            }
            title={autonomous ? '自律モードをOFFにする' : '自律モード(承認なし自動実行)をONにする'}
            onClick={() => {
              if (autonomous) void window.api.autonomousSet(false);
              else setAutoModal(true);
            }}
          >
            {autonomous ? '🔓' : '🔒'}
          </button>
          <div className="relative flex-1">
            <textarea
              className={
                'max-h-40 w-full resize-none rounded-xl border border-zinc-600 bg-zinc-800 py-2 pl-3 text-sm outline-none focus:border-blue-500 ' +
                (busy ? 'pr-12' : 'pr-3')
              }
              rows={2}
              placeholder={
                busy
                  ? '追加の指示を入力(実行中でも送れる・次のターンで反映)'
                  : '指示を入力(Enterで送信 / Shift+Enterで改行)'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.items]
                  .filter((it) => it.kind === 'file')
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => f !== null);
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
            />
            {busy && (
              <button
                className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-black hover:opacity-80"
                title="停止"
                onClick={cancel}
              >
                <span className="block h-3 w-3 rounded-[2px] bg-white" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
      {autoModal && (
        <AutonomousModal
          onConfirm={(registryScope) => {
            setAutoModal(false);
            void window.api.autonomousSet(true, registryScope);
          }}
          onCancel={() => setAutoModal(false)}
        />
      )}
    </div>
  );
}
