import { useEffect, useState } from 'react';
import type { UsageSummary } from '../../../../shared/types';
import { useT, type MessageKey } from '../../i18n';

const fmt = (n: number): string => n.toLocaleString();
const cost = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);

/** M26-4: 帯ラベルの表示名(band無しの旧記録・進化ジョブ等は other に集約される) */
const BAND_LABEL: Record<string, MessageKey> = {
  main: 'usage.bandMain',
  planner: 'usage.bandPlanner',
  worker: 'usage.bandWorker',
  explorer: 'usage.bandExplorer',
  reviewer: 'usage.bandReviewer',
  midEscalation: 'usage.bandMidEscalation',
  escalation: 'usage.bandEscalation',
  fallback: 'usage.bandFallback',
  other: 'usage.bandOther',
};

/**
 * M23-2: 使用量と残高。プロバイダに「残高を返すAPI」は無いため、
 * アプリで実測した使用トークンと概算コストを表示し、正確な残高はダッシュボードへ誘導する
 */
export function UsageSection(): JSX.Element {
  const t = useT();
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  const refresh = (): void => {
    window.api.usageGet().then(setSummary).catch(() => setSummary(null));
  };
  useEffect(refresh, []);

  return (
    <div className="space-y-2 rounded-md border border-zinc-700 p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-zinc-300">{t('usage.heading')}</label>
        <button
          className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
          onClick={refresh}
        >
          {t('usage.refresh')}
        </button>
      </div>

      {summary === null || summary.models.length === 0 ? (
        <p className="text-xs text-zinc-500">{t('usage.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-zinc-500">
              <tr>
                <th className="pr-2">{t('usage.model')}</th>
                <th className="pr-2">{t('usage.todayInOut')}</th>
                <th className="pr-2">{t('usage.todayCost')}</th>
                <th className="pr-2">{t('usage.totalInOut')}</th>
                <th>{t('usage.totalCost')}</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {summary.models.map((m) => (
                <tr key={m.model} className="border-t border-zinc-800">
                  <td className="pr-2 font-mono">{m.model}</td>
                  <td className="pr-2 font-mono">
                    {fmt(m.today.input)}/{fmt(m.today.output)}
                  </td>
                  <td className="pr-2 font-mono">{cost(m.today.costUsd)}</td>
                  <td className="pr-2 font-mono">
                    {fmt(m.total.input)}/{fmt(m.total.output)}
                  </td>
                  <td className="font-mono">{cost(m.total.costUsd)}</td>
                </tr>
              ))}
              <tr className="border-t border-zinc-700 font-semibold">
                <td className="pr-2">{t('usage.total')}</td>
                <td />
                <td className="pr-2 font-mono">{cost(summary.todayCostUsd)}</td>
                <td />
                <td className="font-mono">{cost(summary.totalCostUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {summary !== null && summary.bands.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-1 text-[11px] font-semibold text-zinc-400">{t('usage.bandHeading')}</p>
          <table className="w-full text-left text-[11px]">
            <thead className="text-zinc-500">
              <tr>
                <th className="pr-2">{t('usage.band')}</th>
                <th className="pr-2">{t('usage.todayInOut')}</th>
                <th className="pr-2">{t('usage.todayCost')}</th>
                <th className="pr-2">{t('usage.totalInOut')}</th>
                <th>{t('usage.totalCost')}</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {summary.bands.map((b) => (
                <tr key={b.band} className="border-t border-zinc-800">
                  <td className="pr-2">{BAND_LABEL[b.band] !== undefined ? t(BAND_LABEL[b.band]!) : b.band}</td>
                  <td className="pr-2 font-mono">
                    {fmt(b.today.input)}/{fmt(b.today.output)}
                  </td>
                  <td className="pr-2 font-mono">{cost(b.today.costUsd)}</td>
                  <td className="pr-2 font-mono">
                    {fmt(b.total.input)}/{fmt(b.total.output)}
                  </td>
                  <td className="font-mono">{cost(b.total.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-zinc-500">{t('usage.note')}</p>
      <div className="flex gap-2">
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => void window.api.openBillingPage('anthropic')}
        >
          {t('usage.openAnthropic')}
        </button>
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => void window.api.openBillingPage('openai')}
        >
          {t('usage.openOpenai')}
        </button>
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => void window.api.openBillingPage('moonshot')}
        >
          {t('usage.openMoonshot')}
        </button>
      </div>
    </div>
  );
}
