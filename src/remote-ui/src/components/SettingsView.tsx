import { useEffect, useState } from 'react';
import type { RemoteApi } from '../api';
import type { UsageSummary } from '../../../shared/types';
import { applyTheme, loadTheme, type Theme } from '../theme';

/**
 * M23-3: スマホ用の設定タブ。サーバ側ホワイトリストの安全なサブセットのみ変更できる
 * (workspace / scopeMode / 編集後フック / APIキー / リモート設定は変更不可 = デスクトップ専用)。
 * M23-2: 使用量(残高に準ずるもの)もここに表示する
 */

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtCost = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);

export function SettingsView({ api }: { api: RemoteApi }): JSX.Element {
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [notice, setNotice] = useState('');
  // M25-4: テーマはサーバ設定ではなく端末ローカルのUI好み(デスクトップと同様、localStorage保存)
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());

  const refresh = (): void => {
    api.settingsGet().then(setCfg).catch((e: unknown) => setNotice(String(e)));
    api.usage().then(setUsage).catch(() => setUsage(null));
  };
  useEffect(refresh, [api]);

  const patch = (p: Record<string, unknown>): void => {
    setNotice('');
    api
      .settingsSet(p)
      .then((next) => {
        setCfg(next);
        setNotice('保存した');
      })
      .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  };

  if (!cfg) return <div className="content"><p className="muted">設定を読込中… {notice}</p></div>;

  const auto = (cfg['autoApprove'] ?? {}) as Record<string, boolean>;
  const provider = String(cfg['provider'] ?? 'anthropic');
  const policyOn = (cfg['modelPolicy'] as { enabled?: boolean } | undefined)?.enabled === true;

  return (
    <div className="content">
      <div className="card">
        <h3>表示</h3>
        <label className="row">
          テーマ
          <select
            value={theme}
            onChange={(e) => {
              const next = e.target.value === 'light' ? 'light' : 'dark';
              setThemeState(next);
              applyTheme(next);
            }}
          >
            <option value="dark">ダーク</option>
            <option value="light">ライト</option>
          </select>
        </label>
        <p className="muted">この端末のブラウザだけに保存される(サーバ設定ではない)</p>
      </div>

      <div className="card">
        <h3>モデル</h3>
        <label className="row">
          プロバイダ
          <select value={provider} onChange={(e) => patch({ provider: e.target.value })}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label className="row">
          モデルID(空=既定)
          <input
            defaultValue={String(cfg['model'] ?? '')}
            placeholder="例: claude-fable-5"
            onBlur={(e) => {
              if (e.target.value.trim() !== String(cfg['model'] ?? '')) patch({ model: e.target.value.trim() });
            }}
          />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={policyOn}
            onChange={(e) => {
              const mp = cfg['modelPolicy'] as Record<string, unknown> | undefined;
              if (mp) patch({ modelPolicy: { ...mp, enabled: e.target.checked } });
              else setNotice('モデル自動切替の帯設定はデスクトップで行う(ここではON/OFFのみ)');
            }}
          />
          モデル自動切替(planner/worker帯)
        </label>
      </div>

      <div className="card">
        <h3>自動承認・実行</h3>
        {(['safe', 'write', 'exec'] as const).map((k) => (
          <label key={k} className="row">
            <input
              type="checkbox"
              checked={auto[k] === true}
              onChange={(e) => patch({ autoApprove: { ...auto, [k]: e.target.checked } })}
            />
            {k}(
            {k === 'safe' ? '読み取り' : k === 'write' ? '書き込み' : 'コマンド実行'})
          </label>
        ))}
        <label className="row">
          最大ターン数
          <input
            type="number"
            defaultValue={cfg['maxTurns'] !== undefined ? Number(cfg['maxTurns']) : ''}
            placeholder="既定30"
            onBlur={(e) => {
              const v = e.target.value.trim();
              patch({ maxTurns: v === '' ? null : Math.min(200, Math.max(1, Math.round(Number(v)))) });
            }}
          />
        </label>
        <label className="row">
          サブエージェント同時数
          <select
            value={cfg['subAgentMaxParallel'] !== undefined ? Number(cfg['subAgentMaxParallel']) : 3}
            onChange={(e) => {
              const n = Number(e.target.value);
              patch({ subAgentMaxParallel: n === 3 ? null : n });
            }}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 3 ? '(既定)' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          workspace・操作範囲(fullPc)・編集後フック・APIキーはデスクトップでのみ変更できる
        </p>
      </div>

      <div className="card">
        <h3>使用量と残高(概算)</h3>
        {usage === null || usage.models.length === 0 ? (
          <p className="muted">まだ使用記録が無い</p>
        ) : (
          <>
            {usage.models.map((m) => (
              <p key={m.model} className="muted" style={{ margin: '2px 0' }}>
                <b>{m.model}</b>
                <br />
                今日 {fmtTokens(m.today.input)}/{fmtTokens(m.today.output)} {fmtCost(m.today.costUsd)} ・ 累計{' '}
                {fmtTokens(m.total.input)}/{fmtTokens(m.total.output)} {fmtCost(m.total.costUsd)}
              </p>
            ))}
            <p style={{ marginTop: 4 }}>
              <b>今日の概算合計: {fmtCost(usage.todayCostUsd)}</b>(累計 {fmtCost(usage.totalCostUsd)})
            </p>
          </>
        )}
        <p className="muted">正確な残高は各プロバイダのダッシュボード(console.anthropic.com 等)で確認</p>
        <button onClick={refresh}>更新</button>
      </div>

      {notice && <p className="muted">{notice}</p>}
    </div>
  );
}
