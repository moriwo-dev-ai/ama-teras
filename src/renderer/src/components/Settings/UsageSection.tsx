import { useEffect, useState } from 'react';
import type { UsageSummary } from '../../../../shared/types';

const fmt = (n: number): string => n.toLocaleString();
const cost = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);

/**
 * M23-2: 使用量と残高。プロバイダに「残高を返すAPI」は無いため、
 * アプリで実測した使用トークンと概算コストを表示し、正確な残高はダッシュボードへ誘導する
 */
export function UsageSection(): JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  const refresh = (): void => {
    window.api.usageGet().then(setSummary).catch(() => setSummary(null));
  };
  useEffect(refresh, []);

  return (
    <div className="space-y-2 rounded-md border border-zinc-700 p-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-zinc-300">使用量と残高(概算)</label>
        <button
          className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
          onClick={refresh}
        >
          更新
        </button>
      </div>

      {summary === null || summary.models.length === 0 ? (
        <p className="text-xs text-zinc-500">まだ使用記録が無い(このバージョン導入以降のLLM呼び出しを集計)</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-zinc-500">
              <tr>
                <th className="pr-2">モデル</th>
                <th className="pr-2">今日 in/out</th>
                <th className="pr-2">今日$</th>
                <th className="pr-2">累計 in/out</th>
                <th>累計$</th>
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
                <td className="pr-2">合計</td>
                <td />
                <td className="pr-2 font-mono">{cost(summary.todayCostUsd)}</td>
                <td />
                <td className="font-mono">{cost(summary.totalCostUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-zinc-500">
        コストは既知単価からの概算(cache読み取りは0.1×入力単価で計上・未知モデルは「—」)。
        プロバイダは残高取得APIを提供していないため、正確な残高は各ダッシュボードで:
      </p>
      <div className="flex gap-2">
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => void window.api.openBillingPage('anthropic')}
        >
          Anthropic残高を開く ↗
        </button>
        <button
          className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => void window.api.openBillingPage('openai')}
        >
          OpenAI残高を開く ↗
        </button>
      </div>
    </div>
  );
}
