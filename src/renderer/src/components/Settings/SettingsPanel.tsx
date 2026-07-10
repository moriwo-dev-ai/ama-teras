import { useEffect, useState } from 'react';
import type { AppConfig, SecretSlot, SecretsStatus } from '../../../../shared/types';
import { animEnabled, setAnimEnabled } from '../../lib/animPref';
import { currentTheme, setTheme as persistTheme } from '../../lib/themePref';
import { BasicSection } from './BasicSection';
import { ConnectionsSection } from './ConnectionsSection';
import { MemorySection } from './MemorySection';
import { ModelOpsSection } from './ModelOpsSection';
import { QualitySection } from './QualitySection';

/**
 * M26-5: 設定画面をタブ分け(基本 / モデル運用 / 品質 / 接続 / 記憶)。
 * 各タブの中身は同ディレクトリの *Section.tsx に切り出し、状態(config等)は
 * 従来どおりこのコンポーネントに集約して props で渡す(zustand は導入しない)。
 * タブUIは Layout/RightPane.tsx の既存パターンを流用
 */

type SettingsTab = 'basic' | 'models' | 'quality' | 'connect' | 'memory';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'basic', label: '基本' },
  { id: 'models', label: 'モデル運用' },
  { id: 'quality', label: '品質' },
  { id: 'connect', label: '接続' },
  { id: 'memory', label: '記憶' },
];

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [memory, setMemory] = useState('');
  const [userMemory, setUserMemory] = useState('');
  const [animOn, setAnimOn] = useState(animEnabled());
  const [theme, setTheme] = useState(currentTheme());
  const [tab, setTab] = useState<SettingsTab>('basic');

  useEffect(() => {
    void window.api.settingsGet().then(setConfig);
    void window.api.secretsStatus().then(setStatus);
    void window.api.memoryGet().then(setMemory);
    void window.api.userMemoryGet().then(setUserMemory);
  }, []);

  if (!config) return <div className="p-4 text-sm text-zinc-400">読込中…</div>;

  const updateConfig = async (patch: Partial<AppConfig>): Promise<void> => {
    const next = { ...config, ...patch };
    setConfig(await window.api.settingsSet(next));
  };

  /** delete したフィールドの反映が必要な保存(patchマージではなく全量) */
  const saveConfig = (next: AppConfig): void => {
    void window.api.settingsSet(next).then(setConfig);
  };

  // M27-1: 保存先スロット(プロバイダ or 無料APIプリセット)は BasicSection 側が決める
  const saveKey = async (slot: SecretSlot, key: string): Promise<void> => {
    if (!key.trim()) return;
    try {
      setStatus(await window.api.secretsSet(slot, key));
      setNotice('APIキーを保存した(OS暗号化ストレージ)');
    } catch (err) {
      setNotice(`保存失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      <div className="flex max-h-[90vh] w-[560px] max-w-[90vw] flex-col rounded-lg border border-zinc-600 bg-zinc-900 text-sm shadow-xl">
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="font-semibold">設定</h2>
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            <label className="flex items-center gap-1">
              テーマ
              <select
                className="rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 text-xs"
                value={theme}
                onChange={(e) => {
                  const next = e.target.value === 'light' ? 'light' : 'dark';
                  setTheme(next);
                  persistTheme(next);
                }}
              >
                <option value="dark">ダーク</option>
                <option value="light">ライト</option>
              </select>
            </label>
            <label className="flex items-center gap-1" title="メッセージ表示・タブ切替などの控えめな動き。OSの「視差効果を減らす」が有効な場合はONでも動かない">
              <input
                type="checkbox"
                checked={animOn}
                onChange={(e) => {
                  setAnimEnabled(e.target.checked);
                  setAnimOn(e.target.checked);
                }}
              />
              アニメ
            </label>
            <button className="text-zinc-400 hover:text-zinc-200" onClick={onClose}>
              ✕ 閉じる
            </button>
          </div>
        </div>

        {/* タブ(RightPaneと同じパターン) */}
        <div className="mt-2 flex border-b border-zinc-800 px-5 text-xs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`relative px-2.5 py-1.5 ${
                tab === t.id ? 'border-b-2 border-blue-500 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* key=tab でタブ切替時に再マウントさせてフェードインを発火する */}
        <div key={tab} className="anim-fade min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'basic' && (
            <BasicSection
              config={config}
              setConfig={setConfig}
              updateConfig={updateConfig}
              saveConfig={saveConfig}
              secrets={status}
              onSaveKey={saveKey}
            />
          )}
          {tab === 'models' && (
            <ModelOpsSection config={config} secrets={status} saveConfig={saveConfig} />
          )}
          {tab === 'quality' && (
            <QualitySection config={config} saveConfig={saveConfig} updateConfig={updateConfig} />
          )}
          {tab === 'connect' && <ConnectionsSection />}
          {tab === 'memory' && (
            <MemorySection
              userMemory={userMemory}
              setUserMemory={setUserMemory}
              onSaveUserMemory={async () => {
                await window.api.userMemorySet(userMemory);
                setNotice('ユーザー方針を保存した(AMATERAS-USER.md)');
              }}
              memory={memory}
              setMemory={setMemory}
              onSaveMemory={async () => {
                await window.api.memorySet(memory);
                setNotice('プロジェクト記憶を保存した(AMATERAS.md)');
              }}
            />
          )}
          {notice && <p className="mt-3 text-xs text-zinc-400">{notice}</p>}
        </div>
      </div>
    </div>
  );
}
