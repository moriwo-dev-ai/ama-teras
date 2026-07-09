/**
 * M26-5: 設定「記憶」タブ — ユーザー方針(AMATERAS-USER.md)/ プロジェクト記憶(AMATERAS.md)。
 * 状態は SettingsPanel に集約し props で受ける
 */
export function MemorySection({
  userMemory,
  setUserMemory,
  onSaveUserMemory,
  memory,
  setMemory,
  onSaveMemory,
}: {
  userMemory: string;
  setUserMemory: (v: string) => void;
  onSaveUserMemory: () => Promise<void>;
  memory: string;
  setMemory: (v: string) => void;
  onSaveMemory: () => Promise<void>;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">
          ユーザー方針(AMATERAS-USER.md・全プロジェクト共通で system プロンプトへ注入)
        </label>
        <textarea
          className="h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          value={userMemory}
          placeholder={'例:\n- ユーザーが体験する成果物は必ずツールで動作確認してから完了とする\n- 報告は結論から'}
          onChange={(e) => setUserMemory(e.target.value)}
        />
        <button
          className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
          onClick={() => void onSaveUserMemory()}
        >
          方針を保存
        </button>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">
          プロジェクト記憶(AMATERAS.md・作業フォルダに保存され system プロンプトへ注入)
        </label>
        <textarea
          className="h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          value={memory}
          placeholder={'例:\n- 返答は必ず日本語\n- このリポジトリのテストは vitest'}
          onChange={(e) => setMemory(e.target.value)}
        />
        <button
          className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
          onClick={() => void onSaveMemory()}
        >
          記憶を保存
        </button>
      </div>
    </div>
  );
}
