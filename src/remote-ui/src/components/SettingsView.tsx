import { useEffect, useState } from 'react';
import type { RemoteApi } from '../api';
import type { ModelPolicy, ProviderId, UsageSummary } from '../../../shared/types';
import { applyTheme, loadTheme, type Theme } from '../theme';

/**
 * M23-3: スマホ用の設定タブ。サーバ側の許可リスト(shared/remoteSettings)にあるキーだけ触れる。
 * workspace / scopeMode / 編集後フック / APIキー / リモート設定 / 月読 は**リモートから触らせない**
 * (エージェントの権限境界そのもの・OSキーチェーン依存・自分自身の認証設定だから)。
 *
 * M56で直したもの(どれも「触れない」ではなく「壊れていた」):
 * - モデル自動切替のチェックボックスが、帯が未設定だと**押しても状態が変わらない**(戻る)だけだった
 * - 最大ターン数が非制御入力で、500と打つと200が保存されるのに**画面は500のまま**だった
 * - 保存の成否メッセージが画面最下部にしか出ず、上のカードを触っても**気付けなかった**
 * - modelPolicy が有効なとき、効かないモデル欄を無言で触らせていた(PC版は警告を出す)
 * - サブエージェント最大ターン数・フォールバックはAPIが受け付けるのにUIが無かった
 */

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtCost = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);

/** サーバが黙って丸める上限。UIも同じ値でクランプし、**保存された値をそのまま表示する** */
const MAX_TURNS_CAP = 200;

export function SettingsView({ api }: { api: RemoteApi }): JSX.Element {
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  // M25-4: テーマはサーバ設定ではなく端末ローカルのUI好み(デスクトップと同様、localStorage保存)
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());

  // M99-17: スマホからのdev.toキー登録(英語記事のpull型出口を今夜から使うため)。
  // 宣言は refresh より前に置く(過去にTDZで画面が真っ白になった教訓)
  const [secretsInfo, setSecretsInfo] = useState<Record<string, boolean> | null>(null);
  const [devtoKey, setDevtoKey] = useState('');

  const refresh = (): void => {
    api.settingsGet().then(setCfg).catch((e: unknown) => setError(String(e)));
    api.usage().then(setUsage).catch(() => setUsage(null));
    // M99-17: 秘密の有無だけ(値は返らない)。旧サーバでは404になるので握りつぶす
    api
      .secretsStatus()
      .then(setSecretsInfo)
      .catch(() => setSecretsInfo(null));
  };
  useEffect(refresh, [api]);

  const patch = (p: Record<string, unknown>): void => {
    setNotice('');
    setError('');
    api
      .settingsSet(p)
      .then((next) => {
        setCfg(next); // 保存後のサーバ値で描き直す = 画面と実体が食い違わない
        setNotice('保存した');
        setTimeout(() => setNotice(''), 2000);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  if (!cfg) return <div className="content"><p className="muted">設定を読込中… {error}</p></div>;

  const auto = (cfg['autoApprove'] ?? {}) as Record<string, boolean>;
  const provider = String(cfg['provider'] ?? 'anthropic');
  const policy = cfg['modelPolicy'] as ModelPolicy | undefined;
  const policyOn = policy?.enabled === true;
  const fallback = cfg['fallback'] as { enabled: boolean; provider: ProviderId; model: string } | undefined;
  const maxTurns = cfg['maxTurns'] !== undefined ? Number(cfg['maxTurns']) : '';

  return (
    <div className="content">
      {/* 保存の成否は画面の一番上に固定して出す。以前は最下部にあり、
          上のカードを編集しても成功もエラーも視界に入らなかった */}
      {(notice !== '' || error !== '') && (
        <div className={error !== '' ? 'error-banner' : 'warn-banner'} style={{ position: 'sticky', top: 0, zIndex: 2 }}>
          {error !== '' ? `保存できなかった: ${error}` : '✓ 保存した'}
        </div>
      )}

      {/* M99-17: dev.to APIキー(スマホから登録可。値は暗号化保存され、二度と表示されない) */}
      <div className="card">
        <h3>📤 dev.to(英語記事){secretsInfo?.['devto'] === true ? ' — 設定済み ✓' : ''}</h3>
        <p className="muted" style={{ fontSize: 11 }}>
          dev.to → Settings → Extensions → DEV Community API Keys で発行したキーを登録。
          記事は岩戸ゲートの全文承認後に「下書き」として送られ、公開の最終ボタンはdev.to上で押す
        </p>
        <div className="row">
          <input
            type="password"
            placeholder="dev.to APIキー"
            value={devtoKey}
            onChange={(e) => setDevtoKey(e.target.value.trim())}
            style={{ flex: 1 }}
          />
          <button
            className="primary"
            disabled={devtoKey === ''}
            onClick={() => {
              void api
                .secretsSetDevto(devtoKey)
                .then(() => {
                  setDevtoKey('');
                  setNotice('dev.toキーを保存した(送信は毎回承認制)');
                  setError('');
                  refresh();
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            保存
          </button>
        </div>
      </div>

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
            <option value="moonshot">Moonshot(Kimi)</option>
          </select>
        </label>
        <label className="row">
          モデルID(空=既定)
          <input
            key={String(cfg['model'] ?? '')} // サーバ値が変わったら入力欄も作り直す
            defaultValue={String(cfg['model'] ?? '')}
            placeholder="例: claude-opus-4-8"
            disabled={policyOn}
            onBlur={(e) => {
              if (e.target.value.trim() !== String(cfg['model'] ?? '')) patch({ model: e.target.value.trim() });
            }}
          />
        </label>
        {policyOn && (
          <p className="muted">⚠ モデル自動切替がONの間、このモデル欄は使われない(帯ごとのモデルが優先される)</p>
        )}

        {/* 帯(planner/worker)はスマホから作らせない。作るには最低2帯の指定が要る = 事故のもと。
            既にPCで作ってあるなら、ON/OFFの切替と現在の中身の確認はここでできる */}
        <label className="row">
          <input
            type="checkbox"
            checked={policyOn}
            disabled={policy === undefined}
            onChange={(e) => {
              if (policy !== undefined) patch({ modelPolicy: { ...policy, enabled: e.target.checked } });
            }}
          />
          モデル自動切替(planner/worker帯)
        </label>
        {policy === undefined ? (
          <p className="muted">帯が未設定。帯の作成はデスクトップで(ここでは既存設定のON/OFFのみ)</p>
        ) : (
          <p className="muted">
            planner: {policy.planner.model || '(既定)'} / worker: {policy.worker.model || '(既定)'}
            {policy.explorer && ` / explorer: ${policy.explorer.model || '(既定)'}`}
          </p>
        )}
      </div>

      {/* M56: 残高が尽きたときの逃げ道。出先でこそ効くのに、UIが無かった */}
      <div className="card">
        <h3>フォールバック(課金エラー時)</h3>
        <label className="row">
          <input
            type="checkbox"
            checked={fallback?.enabled === true}
            onChange={(e) =>
              patch({
                fallback: {
                  enabled: e.target.checked,
                  provider: fallback?.provider ?? 'openai',
                  model: fallback?.model ?? '',
                },
              })
            }
          />
          残高切れ等で自動的に切り替える(1会話1回まで)
        </label>
        {fallback?.enabled === true && (
          <>
            <label className="row">
              切替先プロバイダ
              <select
                value={fallback.provider}
                onChange={(e) => patch({ fallback: { ...fallback, provider: e.target.value as ProviderId } })}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
            <option value="moonshot">Moonshot(Kimi)</option>
              </select>
            </label>
            <label className="row">
              切替先モデル(空=既定)
              <input
                key={fallback.model}
                defaultValue={fallback.model}
                onBlur={(e) => {
                  if (e.target.value.trim() !== fallback.model) patch({ fallback: { ...fallback, model: e.target.value.trim() } });
                }}
              />
            </label>
          </>
        )}
        <p className="muted">発動しても本体の設定は書き換えない(その会話の実行だけ切り替わる)</p>
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
          最大ターン数(1〜{MAX_TURNS_CAP})
          <input
            type="number"
            key={String(maxTurns)} // 丸められた値がサーバから返ったら、入力欄もその値に直す
            defaultValue={maxTurns}
            placeholder="既定30"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === '') {
                if (cfg['maxTurns'] !== undefined) patch({ maxTurns: null });
                return;
              }
              const n = Math.min(MAX_TURNS_CAP, Math.max(1, Math.round(Number(v))));
              if (Number.isNaN(n) || n === Number(cfg['maxTurns'])) return; // 変わっていないなら送らない
              patch({ maxTurns: n });
            }}
          />
        </label>
        <label className="row">
          サブエージェント最大ターン数
          <input
            type="number"
            key={String(cfg['subAgentMaxTurns'] ?? '')}
            defaultValue={cfg['subAgentMaxTurns'] !== undefined ? Number(cfg['subAgentMaxTurns']) : ''}
            placeholder="既定15"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === '') {
                if (cfg['subAgentMaxTurns'] !== undefined) patch({ subAgentMaxTurns: null });
                return;
              }
              const n = Math.min(100, Math.max(1, Math.round(Number(v))));
              if (Number.isNaN(n) || n === Number(cfg['subAgentMaxTurns'])) return;
              patch({ subAgentMaxTurns: n });
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
      </div>

      <div className="card">
        <h3>使用量と残高(概算)</h3>
        {usage === null || usage.models.length === 0 ? (
          <p className="muted">まだ使用記録が無い</p>
        ) : (
          <>
            {/* 以前は <p> + <br> の羅列で、モデル名・今日・累計が1段落に潰れていた */}
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr className="muted" style={{ textAlign: 'left' }}>
                  <th>モデル</th>
                  <th style={{ textAlign: 'right' }}>今日</th>
                  <th style={{ textAlign: 'right' }}>累計</th>
                </tr>
              </thead>
              <tbody>
                {usage.models.map((m) => (
                  <tr key={m.model} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ wordBreak: 'break-all', paddingRight: 6 }}>{m.model}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {fmtCost(m.today.costUsd)}
                      <div className="muted">
                        {fmtTokens(m.today.input)}/{fmtTokens(m.today.output)}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {fmtCost(m.total.costUsd)}
                      <div className="muted">
                        {fmtTokens(m.total.input)}/{fmtTokens(m.total.output)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ marginTop: 6 }}>
              <b>今日の概算合計: {fmtCost(usage.todayCostUsd)}</b>(累計 {fmtCost(usage.totalCostUsd)})
            </p>
          </>
        )}
        <p className="muted">正確な残高は各プロバイダのダッシュボード(console.anthropic.com 等)で確認</p>
        <button onClick={refresh}>更新</button>
      </div>

      <div className="card">
        <h3>ここから触れないもの</h3>
        <p className="muted">
          APIキー・Bluesky資格情報(OSの暗号化ストレージにあるため) / workspace・操作範囲・編集後フック
          (エージェントの権限境界そのもののため) / MCPサーバー(外部プロセスを起動するため) /
          リモートアクセス設定(自分自身の認証のため)。いずれもデスクトップで変更する
        </p>
      </div>
    </div>
  );
}
