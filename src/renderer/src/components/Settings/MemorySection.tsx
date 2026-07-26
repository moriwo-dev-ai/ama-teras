/**
 * M26-5: 設定「記憶」タブ — ユーザー方針(AMATERAS-USER.md)/ プロジェクト記憶(AMATERAS.md)。
 * 状態は SettingsPanel に集約し props で受ける
 */
import { useT } from '../../i18n';

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
  const t = useT();
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">
          {t('mem.userHeading')}
        </label>
        <textarea
          className="h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          value={userMemory}
          placeholder={t('mem.userPlaceholder')}
          onChange={(e) => setUserMemory(e.target.value)}
        />
        <button
          className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
          onClick={() => void onSaveUserMemory()}
        >
          {t('mem.saveUser')}
        </button>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">
          {t('mem.projectHeading')}
        </label>
        <textarea
          className="h-24 w-full resize-y rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
          value={memory}
          placeholder={t('mem.projectPlaceholder')}
          onChange={(e) => setMemory(e.target.value)}
        />
        <button
          className="rounded bg-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-600"
          onClick={() => void onSaveMemory()}
        >
          {t('mem.saveProject')}
        </button>
      </div>
    </div>
  );
}
