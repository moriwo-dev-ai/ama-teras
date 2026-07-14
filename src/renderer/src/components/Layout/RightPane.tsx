import { useEffect } from 'react';
import { SubAgentPanel } from '../Agents/SubAgentPanel';
import { ToolDebugPanel } from '../Debug/ToolDebugPanel';
import { EvolutionPanel } from '../Evolution/EvolutionPanel';
import { OperationsPanel } from '../Operations/OperationsPanel';
import { TsukuyomiPanel } from '../Tsukuyomi/TsukuyomiPanel';
import { PlanPanel } from '../Plan/PlanPanel';
import { useEvolutionStore } from '../../stores/evolution';
import { useOperationsStore } from '../../stores/operations';
import { useTsukuyomiStore } from '../../stores/tsukuyomi';
import { usePreviewStore } from '../../stores/preview';
import { useRightPaneStore, type RightPaneTab } from '../../stores/rightPane';
import { useSubAgentStore } from '../../stores/subagents';
import { isJobActive } from '../../../../shared/evolutionStatus';
import { EnvWidget } from './EnvWidget';
import { FilePreview } from './FilePreview';

/**
 * M15-4: 右ペイン — 環境ウィジェット+タブ集約(プレビュー/計画/エージェント/進化/Debug)。
 * 進行中イベント(実行中サブエージェント・進行中進化ジョブ)はタブにバッジ表示。
 */


export function RightPane(): JSX.Element {
  const { tab, setTab } = useRightPaneStore();
  const previewResult = usePreviewStore((s) => s.result);
  const runningAgents = useSubAgentStore((s) => s.agents.filter((a) => a.status === 'running').length);
  const activeJobs = useEvolutionStore((s) => s.jobs.filter((j) => isJobActive(j.status)).length);

  // M32-1: 運営タブはオーナーモード(operations.enabled)の時だけ存在する
  const operationsEnabled = useOperationsStore((s) => s.enabled);
  const refreshOperations = useOperationsStore((s) => s.refresh);
  useEffect(() => {
    void refreshOperations();
  }, [refreshOperations]);
  // オーナーモードOFF化で運営タブに居たらプレビューへ退避
  useEffect(() => {
    if (!operationsEnabled && tab === 'operations') setTab('preview');
  }, [operationsEnabled, tab, setTab]);

  // M42(TUKU-yomi): 月読タブは鍵ファイルがある機体で tsukuyomi.enabled の時だけ存在する
  // (鍵が無ければ main が enabled:false を返すので、UI側の分岐だけに頼っていない)
  const tsukuyomiStatus = useTsukuyomiStore((s) => s.status);
  const refreshTsukuyomi = useTsukuyomiStore((s) => s.refresh);
  useEffect(() => {
    void refreshTsukuyomi();
  }, [refreshTsukuyomi]);
  const tsukuyomiEnabled = tsukuyomiStatus?.enabled === true;
  useEffect(() => {
    if (!tsukuyomiEnabled && tab === 'tsukuyomi') setTab('preview');
  }, [tsukuyomiEnabled, tab, setTab]);

  // プレビューを開いたらプレビュータブへ
  useEffect(() => {
    if (previewResult) setTab('preview');
  }, [previewResult, setTab]);

  const tabs: { id: RightPaneTab; label: string; badge?: number }[] = [
    { id: 'preview', label: '📄' },
    { id: 'plan', label: '計画' },
    { id: 'agents', label: 'エージェント', ...(runningAgents > 0 ? { badge: runningAgents } : {}) },
    { id: 'evolution', label: '進化', ...(activeJobs > 0 ? { badge: activeJobs } : {}) },
    ...(operationsEnabled ? [{ id: 'operations' as const, label: '運営' }] : []),
    ...(tsukuyomiEnabled ? [{ id: 'tsukuyomi' as const, label: '月読' }] : []),
    { id: 'debug', label: 'Debug' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EnvWidget />
      <div className="flex border-b border-zinc-800 text-xs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`relative px-2.5 py-1.5 ${
              tab === t.id ? 'border-b-2 border-blue-500 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge !== undefined && (
              <span className="anim-pulse absolute -right-0.5 top-0.5 rounded-full bg-blue-600 px-1 text-[9px] leading-3">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* key=tab でタブ切替時に再マウントさせてフェードインを発火する */}
      <div key={tab} className="anim-fade flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === 'preview' &&
          (previewResult ? (
            <FilePreview />
          ) : (
            <p className="p-3 text-xs text-zinc-500">
              チャット内のファイルパス(ツールカードの 📄 や本文中のパス)をクリックすると
              ここにプレビューが表示される
            </p>
          ))}
        {tab === 'plan' && <PlanPanel />}
        {tab === 'agents' && <SubAgentPanel />}
        {tab === 'evolution' && <EvolutionPanel />}
        {tab === 'operations' && operationsEnabled && <OperationsPanel />}
        {tab === 'tsukuyomi' && tsukuyomiEnabled && <TsukuyomiPanel />}
        {tab === 'debug' && <ToolDebugPanel />}
      </div>
    </div>
  );
}
