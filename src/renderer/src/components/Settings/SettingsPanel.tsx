import { useEffect, useState } from 'react';
import type { AppConfig, SecretSlot, SecretsStatus } from '../../../../shared/types';
import { useT, type MessageKey } from '../../i18n';
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

const TABS: { id: SettingsTab; labelKey: MessageKey }[] = [
  { id: 'basic', labelKey: 'settings.tabBasic' },
  { id: 'models', labelKey: 'settings.tabModels' },
  { id: 'quality', labelKey: 'settings.tabQuality' },
  { id: 'connect', labelKey: 'settings.tabConnect' },
  { id: 'memory', labelKey: 'settings.tabMemory' },
];

export function SettingsPanel({
  onClose,
  initialTab,
}: {
  onClose: () => void;
  /** M30-2: エラーカード等の導線から特定タブで開く(未指定=基本) */
  initialTab?: SettingsTab;
}): JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [memory, setMemory] = useState('');
  const t = useT();
  const [userMemory, setUserMemory] = useState('');
  const [animOn, setAnimOn] = useState(animEnabled());
  const [theme, setTheme] = useState(currentTheme());
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'basic');

  useEffect(() => {
    void window.api.settingsGet().then(setConfig);
    void window.api.secretsStatus().then(setStatus);
    void window.api.memoryGet().then(setMemory);
    void window.api.userMemoryGet().then(setUserMemory);
  }, []);

  if (!config) return <div className="p-4 text-sm text-zinc-400">{t('settings.loading')}</div>;

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
      setNotice(t('settings.keySaved'));
    } catch (err) {
      setNotice(t('settings.saveFailed', { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
      {/* M29-2: 高さは固定(タブ切替でモーダル外形が動かない)。中身側が overflow-y-auto でスクロール */}
      <div className="flex h-[85vh] w-[560px] max-w-[90vw] flex-col rounded-lg border border-zinc-600 bg-zinc-900 text-sm shadow-xl">
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="font-semibold">{t('settings.title')}</h2>
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            <label className="flex items-center gap-1">
              {t('settings.theme')}
              <select
                className="rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 text-xs"
                value={theme}
                onChange={(e) => {
                  const next = e.target.value === 'light' ? 'light' : 'dark';
                  setTheme(next);
                  persistTheme(next);
                }}
              >
                <option value="dark">{t('settings.themeDark')}</option>
                <option value="light">{t('settings.themeLight')}</option>
              </select>
            </label>
            <label className="flex items-center gap-1" title={t('settings.animTitle')}>
              <input
                type="checkbox"
                checked={animOn}
                onChange={(e) => {
                  setAnimEnabled(e.target.checked);
                  setAnimOn(e.target.checked);
                }}
              />
              {t('settings.anim')}
            </label>
            <button className="text-zinc-400 hover:text-zinc-200" onClick={onClose}>
              {t('settings.close')}
            </button>
          </div>
        </div>

        {/* タブ(RightPaneと同じパターン) */}
        <div className="mt-2 flex border-b border-zinc-800 px-5 text-xs">
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              className={`relative px-2.5 py-1.5 ${
                tab === tabDef.id ? 'border-b-2 border-blue-500 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              onClick={() => setTab(tabDef.id)}
            >
              {t(tabDef.labelKey)}
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
              onOpenModels={() => setTab('models')}
            />
          )}
          {tab === 'models' && (
            <ModelOpsSection config={config} secrets={status} saveConfig={saveConfig} />
          )}
          {tab === 'quality' && (
            <QualitySection config={config} saveConfig={saveConfig} updateConfig={updateConfig} />
          )}
          {tab === 'connect' && <ConnectionsSection config={config} saveConfig={saveConfig} />}
          {tab === 'memory' && (
            <MemorySection
              userMemory={userMemory}
              setUserMemory={setUserMemory}
              onSaveUserMemory={async () => {
                await window.api.userMemorySet(userMemory);
                setNotice(t('settings.userMemorySaved'));
              }}
              memory={memory}
              setMemory={setMemory}
              onSaveMemory={async () => {
                await window.api.memorySet(memory);
                setNotice(t('settings.memorySaved'));
              }}
            />
          )}
          {notice && <p className="mt-3 text-xs text-zinc-400">{notice}</p>}
        </div>
      </div>
    </div>
  );
}
