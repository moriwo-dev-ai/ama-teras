import { useEffect, useState } from 'react';
import type { AppConfig, GodClockJob, ModelBand, OperationsConfig } from '../../../../shared/types';
import { DEFAULT_REGISTRY_URL, KNOWN_MODELS } from '../../../../shared/models';
import { estimateOpsCost } from '../../../../shared/opsCost';
import { useOperationsStore } from '../../stores/operations';
import { useTsukuyomiStore } from '../../stores/tsukuyomi';
import { McpSection } from './McpSection';
import { RemoteAccessSection } from './RemoteAccessSection';
import { UsageSection } from './UsageSection';

/**
 * M34-7: 運営専用モデル帯の選択(神議/神々)。
 * 推奨: 神議=Sonnet系(分析品質と単価のバランス。planner=Fable5のままだと
 * 1日2回の定例だけで月1万円級になる)、神々=未設定(worker帯)のまま
 */
const OPS_BAND_CUSTOM = '__custom__';

function OpsBandPicker({
  label,
  hint,
  band,
  onChange,
}: {
  label: string;
  hint: string;
  band: ModelBand | undefined;
  onChange: (band: ModelBand | undefined) => void;
}): JSX.Element {
  // M36-2: モデルは基本タブと同じリスト選択式(KNOWN_MODELS)。自由入力は「カスタム」選択時のみ
  const known = band !== undefined ? KNOWN_MODELS[band.provider] : [];
  const isCustomModel = band !== undefined && band.model !== '' && !known.some((m) => m.id === band.model);
  const [customOpen, setCustomOpen] = useState(false);
  const selectValue = band === undefined ? '' : isCustomModel || customOpen ? OPS_BAND_CUSTOM : band.model;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="w-28 shrink-0 text-zinc-400">{label}</span>
      <select
        className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1 text-xs"
        value={band?.provider ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          setCustomOpen(false);
          onChange(v === '' ? undefined : { provider: v as ModelBand['provider'], model: '' });
        }}
      >
        <option value="">{hint}</option>
        <option value="anthropic">anthropic</option>
        <option value="openai">openai</option>
      </select>
      {band !== undefined && (
        <>
          <select
            className="min-w-[12rem] rounded border border-zinc-600 bg-zinc-800 px-1.5 py-1 text-xs"
            value={selectValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === OPS_BAND_CUSTOM) {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange({ provider: band.provider, model: v });
            }}
          >
            <option value="">(プロバイダ既定)</option>
            {known.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value={OPS_BAND_CUSTOM}>カスタム(モデルIDを直接入力)</option>
          </select>
          {(isCustomModel || customOpen) && (
            <input
              className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
              placeholder="モデルID"
              defaultValue={isCustomModel ? band.model : ''}
              autoFocus={customOpen}
              onBlur={(e) => {
                const v = e.target.value.trim();
                setCustomOpen(false);
                onChange({ provider: band.provider, model: v });
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * M35-4: Bluesky実行系の資格情報(identifier + app password)。
 * secretsの 'bluesky' スロットにJSONで保存(safeStorage暗号化)。
 * 登録すると bluesky アダプタの execute(post/follow/reply・岩戸ゲート承認制)が有効化される
 */
function BlueskyCredsSection(): JSX.Element {
  const [identifier, setIdentifier] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    void window.api.secretsStatus().then((s) => setRegistered(s.bluesky));
  }, []);
  return (
    <div className="space-y-1 rounded border border-zinc-800 p-2">
      <p className="text-xs font-semibold text-zinc-300">
        Bluesky実行系(フォロー・投稿・返信){registered === true ? '(設定済み)' : '(未設定=提案のみ)'}
      </p>
      <p className="text-[10px] text-zinc-500">
        app passwordを登録すると、承認したフォロー・投稿を岩戸ゲート経由で実行できる
        (bsky.app → Settings → App Passwords で発行。メインパスワードは絶対に入れない)。
        プロフィールに「一部運用を自動化(承認制)」の開示を推奨
      </p>
      <div className="flex flex-wrap gap-1.5">
        <input
          className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
          placeholder="ハンドル(例: moriwo.bsky.social)"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value.trim())}
        />
        <input
          type="password"
          className="min-w-[10rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
          placeholder="app password(xxxx-xxxx-xxxx-xxxx)"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value.trim())}
        />
        <button
          className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500 disabled:opacity-40"
          disabled={identifier === '' || appPassword === ''}
          onClick={() => {
            void window.api
              .secretsSet('bluesky', JSON.stringify({ identifier, appPassword }))
              .then((s) => {
                setRegistered(s.bluesky);
                setIdentifier('');
                setAppPassword('');
                setNotice('保存した(実行系が有効化された。実行は毎回あなたの承認制)');
              })
              .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
          }}
        >
          保存
        </button>
      </div>
      {notice !== '' && <p className="text-[10px] text-zinc-400">{notice}</p>}
    </div>
  );
}

/** M34-7: 運営の今日の実測コスト(usage帯別集計の kamuhakari/gods 行) */
function OpsCostToday(): JSX.Element | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void window.api.usageGet().then((summary) => {
      const row = (band: string): number | null =>
        summary.bands.find((b) => b.band === band)?.today.costUsd ?? null;
      const kamu = row('kamuhakari');
      const gods = row('gods');
      if (kamu === null && gods === null) {
        setText('今日の運営コスト実測: まだ記録なし(次回再起動後の実行から kamuhakari/gods として集計)');
      } else {
        const total = (kamu ?? 0) + (gods ?? 0);
        setText(`今日の運営コスト実測: $${total.toFixed(2)}(神議 $${(kamu ?? 0).toFixed(2)} / 神々 $${(gods ?? 0).toFixed(2)})→ 推定月額 $${(total * 30).toFixed(0)}`);
      }
    });
  }, []);
  return text === null ? null : <p className="text-[10px] text-zinc-500">{text}</p>;
}

/** M32-1: オーナーモード(運営タブ)。既定OFF=タブ自体を表示しない */
/**
 * M41-4: 想定コストの導線。オーナーモードONの人が「毎日いくら燃えるか」を先に知れるようにする。
 * 既定値は何も変えない(表示のみ)。実測が出たら OpsCostToday の方が正しい
 */
function OpsCostEstimate({ ops, config }: { ops: OperationsConfig; config: AppConfig }): JSX.Element {
  const [jobs, setJobs] = useState<GodClockJob[]>([]);
  useEffect(() => {
    void window.api.operationsClocks().then(setJobs);
  }, []);
  // 運営専用帯が未設定なら、通常のモデル方針(planner/worker)で見積もる
  const policy = config.modelPolicy;
  const bands = {
    kamuhakari: ops.kamuhakariBand ?? policy?.planner ?? { provider: config.provider, model: config.model },
    gods: ops.godsBand ?? policy?.worker ?? { provider: config.provider, model: config.model },
  };
  const est = estimateOpsCost(jobs, bands);
  if (jobs.length === 0) {
    return (
      <p className="rounded border border-zinc-800 bg-zinc-950 p-2 text-[10px] text-zinc-500">
        想定コスト: 神々の時計がまだ無い(次回起動後に算出)。目安として神議(1日2回)+巡回・門番(1時間ごと)で
        1日10〜30万トークン程度になる。運営専用モデル(下)で安いモデルに寄せられる
      </p>
    );
  }
  return (
    <div className="rounded border border-amber-900 bg-zinc-950 p-2 text-[10px] text-zinc-400">
      <p className="font-semibold text-amber-300">💰 想定コスト(概算・表示のみ)</p>
      <p>
        1日 約{est.dailyTokens.toLocaleString()} トークン
        {est.dailyUsd !== null && est.monthlyUsd !== null ? (
          <>
            {' '}
            → <span className="text-zinc-200">約 ${est.dailyUsd.toFixed(2)}/日(${est.monthlyUsd.toFixed(0)}/月)</span>
          </>
        ) : (
          <>(単価不明のモデルのため金額は出せない)</>
        )}
      </p>
      <p className="text-zinc-500">
        内訳: {est.perGod.filter((g) => g.tokens > 0).map((g) => `${g.godId} ${(g.tokens / 1000).toFixed(0)}k`).join(' / ') || '(LLMを使う神が無い)'}
      </p>
      <p className="text-zinc-500">
        高いと感じたら: 神議のモデルを安い帯にする / 神の実行間隔を広げる / 使わない神を停止する
        (運営タブの AMENO-koyane で調整可能)。実測は下の行に出る
      </p>
    </div>
  );
}

function OwnerModeSection({
  config,
  saveConfig,
}: {
  config: AppConfig;
  saveConfig: (next: AppConfig) => void;
}): JSX.Element {
  const refreshOperations = useOperationsStore((s) => s.refresh);
  const ops = config.operations ?? { enabled: false, repos: [], zennSlugs: [] };
  const save = (next: typeof ops): void => {
    saveConfig({ ...config, operations: next });
    // 保存後にタブ表示・gh検出の状態を反映する
    setTimeout(() => void refreshOperations(), 200);
  };
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-zinc-300">オーナーモード(運営 — Project TAKAMA-gahara)</p>
      <p className="text-xs text-zinc-500">
        自分のリポジトリ・記事の観測、発信ドラフト生成、Issue/PRトリアージを行う
        プロジェクト運営者向けの機能。ONにすると右ペインに「運営」タブが現れる。
        外部への発信(コメント・投稿等)は必ず承認ダイアログ(岩戸ゲート)を通る
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={ops.enabled}
          onChange={(e) => save({ ...ops, enabled: e.target.checked })}
        />
        オーナーモードを有効にする(既定OFF)
      </label>
      {ops.enabled && (
        <div className="space-y-1.5 pl-1 pt-1">
          {/* M41-4: ONにした人が最初に見るべき「いくらかかるか」。既定値は変えない(表示のみ) */}
          <OpsCostEstimate ops={ops} config={config} />
          {/* M41-3: 神々のプロンプトに差し込むプロジェクト像(未設定ならリポジトリ名から推測) */}
          <div className="space-y-1 rounded border border-zinc-800 p-2">
            <p className="text-xs font-semibold text-zinc-300">このプロジェクトについて(神々が読む)</p>
            <p className="text-[10px] text-zinc-500">
              広報ドラフト・記事・トリアージ・神議のプロンプトに差し込まれる。
              未設定なら観測対象リポジトリ名から推測する
            </p>
            <input
              className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
              defaultValue={ops.projectName ?? ''}
              placeholder="プロジェクト名(例: my-awesome-tool)"
              onBlur={(e) => {
                const v = e.target.value.trim();
                save({ ...ops, ...(v !== '' ? { projectName: v } : { projectName: undefined as never }) });
              }}
            />
            {/* M43-1: 発信文の {URL} の解決先。未設定なら観測対象リポジトリのGitHub URL。
                どちらも無ければプレースホルダごと落とす(「{URL}」という文字列を投稿しない) */}
            <input
              className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
              defaultValue={ops.projectUrl ?? ''}
              placeholder="告知したいURL(未設定なら観測対象リポジトリのGitHub URL)"
              onBlur={(e) => {
                const v = e.target.value.trim();
                save({ ...ops, ...(v !== '' ? { projectUrl: v } : { projectUrl: undefined as never }) });
              }}
            />
            <textarea
              className="h-14 w-full rounded border border-zinc-600 bg-zinc-800 p-2 text-xs"
              defaultValue={ops.projectDescription ?? ''}
              placeholder="1〜2文の説明(何ができる道具か。誇張しない)"
              onBlur={(e) => {
                const v = e.target.value.trim();
                save({
                  ...ops,
                  ...(v !== '' ? { projectDescription: v } : { projectDescription: undefined as never }),
                });
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              <input
                className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
                defaultValue={(ops.keywords ?? []).join(', ')}
                placeholder="巡回キーワード(カンマ区切り)"
                onBlur={(e) => {
                  const keywords = e.target.value.split(',').map((k) => k.trim()).filter((k) => k !== '');
                  save({ ...ops, ...(keywords.length > 0 ? { keywords } : { keywords: undefined as never }) });
                }}
              />
              <input
                className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs"
                defaultValue={(ops.zennTopics ?? []).join(', ')}
                placeholder="Zenn topics(カンマ区切り・既定 ai)"
                onBlur={(e) => {
                  const zennTopics = e.target.value.split(',').map((t) => t.trim()).filter((t) => t !== '');
                  save({ ...ops, ...(zennTopics.length > 0 ? { zennTopics } : { zennTopics: undefined as never }) });
                }}
              />
            </div>
          </div>
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">観測対象リポジトリ(owner/repo・改行区切り)</p>
            <textarea
              className="h-16 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={ops.repos.join('\n')}
              placeholder={'moriwo-dev-ai/ama-teras\nmoriwo-dev-ai/amateras-registry'}
              onBlur={(e) =>
                save({ ...ops, repos: e.target.value.split('\n').map((r) => r.trim()).filter((r) => r !== '') })
              }
            />
          </div>
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">観測対象Zenn記事スラッグ(改行区切り)</p>
            <textarea
              className="h-12 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={ops.zennSlugs.join('\n')}
              placeholder="ama-teras-self-evolving-agent"
              onBlur={(e) =>
                save({ ...ops, zennSlugs: e.target.value.split('\n').map((s) => s.trim()).filter((s) => s !== '') })
              }
            />
          </div>
          {/* M34-1: はてブ監視URL(Zenn記事は自動導出されるので追加分のみ) */}
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">
              はてブ数の監視URL(改行区切り・任意。Zenn記事はスラッグから自動導出される)
            </p>
            <textarea
              className="h-12 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={(ops.watchUrls ?? []).join('\n')}
              placeholder="https://github.com/moriwo-dev-ai/ama-teras"
              onBlur={(e) => {
                const watchUrls = e.target.value.split('\n').map((u) => u.trim()).filter((u) => u !== '');
                save({ ...ops, ...(watchUrls.length > 0 ? { watchUrls } : { watchUrls: undefined as never }) });
              }}
            />
          </div>
          {/* M37: Zenn記事化の行き先(zenn-content リポジトリ) */}
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">
              zenn-content リポジトリのパス(記事アウトラインの「Zenn記事化」の行き先)
            </p>
            <input
              className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
              defaultValue={ops.zennRepoDir ?? ''}
              placeholder="C:\dev\zenn-content"
              onBlur={(e) => {
                const v = e.target.value.trim();
                save({ ...ops, ...(v !== '' ? { zennRepoDir: v } : { zennRepoDir: undefined as never }) });
              }}
            />
            <p className="text-[10px] text-zinc-500">
              コミットは必ず published: false(非公開)。公開はZennの記事設定であなたが行う
            </p>
          </div>
          {/* M34-2: HN監視(読み取りのみ) */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-zinc-400">HNユーザー(karma・返信監視)</span>
            <input
              className="rounded border border-zinc-600 bg-zinc-800 px-2 py-1 font-mono text-xs"
              defaultValue={ops.hnUser ?? ''}
              placeholder="moriwo-dev-ai"
              onBlur={(e) => {
                const v = e.target.value.trim();
                save({ ...ops, ...(v !== '' ? { hnUser: v } : { hnUser: undefined as never }) });
              }}
            />
          </div>
          <div>
            <p className="mb-0.5 text-xs text-zinc-400">HN監視スレッド(item?id=のURLかID・改行区切り)</p>
            <textarea
              className="h-12 w-full rounded border border-zinc-600 bg-zinc-800 p-2 font-mono text-xs"
              defaultValue={(ops.hnThreads ?? []).join('\n')}
              placeholder="https://news.ycombinator.com/item?id=48845422"
              onBlur={(e) => {
                const hnThreads = e.target.value.split('\n').map((t) => t.trim()).filter((t) => t !== '');
                save({ ...ops, ...(hnThreads.length > 0 ? { hnThreads } : { hnThreads: undefined as never }) });
              }}
            />
          </div>
          {/* M34-7: 運営専用モデル帯(コスト管理) */}
          <div className="space-y-1 rounded border border-zinc-800 p-2">
            <p className="text-xs font-semibold text-zinc-300">運営専用モデル(コスト管理)</p>
            <p className="text-[10px] text-zinc-500">
              神議は1日2回・planner帯(最上位モデル)で動くため運営コストの大半を占める。
              推奨: 神議=Sonnet系 / 神々=未設定(worker帯)のまま
            </p>
            <OpsBandPicker
              label="神議(分析・週報)"
              hint="(従来どおり planner帯)"
              band={ops.kamuhakariBand}
              onChange={(band) =>
                save({ ...ops, ...(band !== undefined ? { kamuhakariBand: band } : { kamuhakariBand: undefined as never }) } as OperationsConfig)
              }
            />
            <OpsBandPicker
              label="神々(判定・下書き)"
              hint="(従来どおり worker帯)"
              band={ops.godsBand}
              onChange={(band) =>
                save({ ...ops, ...(band !== undefined ? { godsBand: band } : { godsBand: undefined as never }) } as OperationsConfig)
              }
            />
            <OpsCostToday />
          </div>
          <BlueskyCredsSection />
        </div>
      )}
    </div>
  );
}

/**
 * M26-5: 設定「接続」タブ — リモートアクセス / MCP / 使用量。
 * M28-3: コミュニティレジストリURL(「作る前に探す」)を追加
 */

/**
 * M42(TUKU-yomi): 月読モードのトグル。**鍵ファイルがある機体でしか描画しない**(鉄則4)。
 * 鍵の有無は main が status.ownerKeyPresent で返す(UIの出し分けだけに頼らず、
 * 鍵が無ければ main 側の設定正規化が enabled を false に落とす)
 */
function TsukuyomiSection({
  config,
  saveConfig,
}: {
  config: AppConfig;
  saveConfig: (next: AppConfig) => void;
}): JSX.Element | null {
  const status = useTsukuyomiStore((s) => s.status);
  const refresh = useTsukuyomiStore((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const tsu = config.tsukuyomi ?? { enabled: false };
  const save = (next: typeof tsu): void => {
    saveConfig({ ...config, tsukuyomi: next });
    setTimeout(() => void refresh(), 200);
  };
  // 鍵が無い機体ではトグル自体を出さない(存在を匂わせない)
  if (status === null || !status.ownerKeyPresent) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-zinc-300">🌙 月読(TUKU-yomi)— オーナー機体限定・実験的機能</p>
      <p className="text-xs text-zinc-500">
        あなた自身の約束・決定・ToDoを覚えておく「記憶の義手」。ONにすると右ペインに「月読」タブが出る。
        生の音声・映像は保存せず、観察は7日で忘れる。自発的な声かけには1日あたりの上限がある
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={tsu.enabled} onChange={(e) => save({ ...tsu, enabled: e.target.checked })} />
        月読モードを有効にする(既定OFF)
      </label>
      {tsu.enabled && (
        <div className="space-y-1 pl-1 pt-1">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={tsu.voiceOutput === true}
              onChange={(e) => save({ ...tsu, voiceOutput: e.target.checked })}
            />
            口: PCのスピーカーから実際に喋る(既定OFF)
          </label>
          {/* M42-3: 目。ONの間は必ず「📷 見守り中」が出る(消せない)。停止は1クリック */}
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={tsu.camera === true}
              onChange={(e) => save({ ...tsu, camera: e.target.checked, ...(e.target.checked ? {} : { cameraUnderstanding: false }) })}
            />
            目: カメラで在席を見る(既定OFF・**APIには何も送らない**・映像は保存しない)
          </label>
          {/* M42-4: 理解=API送信。カメラとは別トグル。何が起きるかを明示する */}
          {tsu.camera === true && (
            <label className="flex items-center gap-2 pl-5 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={tsu.cameraUnderstanding === true}
                onChange={(e) => save({ ...tsu, cameraUnderstanding: e.target.checked })}
              />
              映像理解: **選別した静止画をAnthropic APIに送信します**(既定OFF・上限
              {tsu.framesPerHour ?? 6}枚/時・{tsu.framesPerDay ?? 50}枚/日・送信後に保存しない)
            </label>
          )}
          {/* M42-5b: 耳。ONの間は必ず「👂 聴取中」が出る(消せない)。停止は1クリック。
              音声はローカルwhisperだけを通り、APIには送らない */}
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={tsu.ears === true}
              onChange={(e) => save({ ...tsu, ears: e.target.checked })}
            />
            耳: 常時聴取(既定OFF・抽出結果はあなたの承認後に帳へ)
          </label>
          {/* M42-7: 文字起こしの場所。音声の行き先が変わる設定なので、選択肢に明記する
              (cloud はイヤホンマイク装着が前提。同席者・テレビを拾いにくくするため) */}
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            文字起こし
            <select
              className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
              value={tsu.sttMode ?? 'local'}
              onChange={(e) => save({ ...tsu, sttMode: e.target.value === 'cloud' ? 'cloud' : 'local' })}
            >
              <option value="local">このPCの中(whisper・音声を外に出さない・遅い)</option>
              <option value="cloud">クラウド(OpenAI・音声を送る・速い)</option>
            </select>
          </label>
          {/* M43-3: 使うマイク。既定のままだとイヤホンを着けていても内蔵マイクを拾い、
              遠くの声を誤認識する(実機で「明日の予定は?」が「一番」になった) */}
          <MicPicker value={tsu.micDeviceId ?? ''} onChange={(id) => save({ ...tsu, micDeviceId: id })} />
          {/* M43-1: 会話。押して話すと月読が声で返す。根拠は月の帳だけ(作話させない) */}
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={tsu.conversation === true}
              onChange={(e) => save({ ...tsu, conversation: e.target.checked })}
            />
            会話: 話しかけると声で返す(既定OFF・答えの根拠は**月の帳だけ**・帳に無いことは「記録にありません」)
          </label>
          {/* M43-4: 呼びかけ。常時聴取に返事をさせるのは「呼ばれた時」だけ
              (呼ばれていない独り言・テレビの音に喋り出したら事故) */}
          {tsu.conversation === true && (
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={tsu.wakeWord !== false}
                onChange={(e) => save({ ...tsu, wakeWord: e.target.checked })}
              />
              呼びかけ: 名前を呼ぶと常時聴取でも会話に入る(呼んだ後30秒は呼び直し不要。
              OFFなら押して話す時だけ会話する)
            </label>
          )}
          {/* M44-1: 声で操作。副作用のある操作は復唱+確認語。外部発信・リリースは声からは動かない */}
          {tsu.conversation === true && (
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={tsu.voiceCommand === true}
                onChange={(e) => save({ ...tsu, voiceCommand: e.target.checked })}
              />
              声で操作: 「承認待ち何件?」「メトリクスの神を動かして」等(既定OFF)。
              **実行前に必ず復唱して「実行して」の一言を待つ**(「うん」では動かない)。
              **X/Bluesky/Zennへの投稿・GitHubリリースは声からは実行できない**(画面の承認のみ)
            </label>
          )}
          {tsu.conversation === true && tsu.wakeWord !== false && (
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              呼びかけの言葉
              <input
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs"
                placeholder="アマテラス(カンマ区切りで複数可)"
                defaultValue={tsu.wakeWords ?? ''}
                onBlur={(e) => save({ ...tsu, wakeWords: e.target.value.trim() })}
              />
            </label>
          )}
          {tsu.conversation === true && tsu.wakeWord !== false && (
            <p className="text-[10px] text-zinc-500">
              文字起こしが**安定して返す語**を選ぶこと。実機で「つくよみ」は「月曜日」「作り」に化けて
              呼びかけが通らなかった(3音は日本語に似た音が多すぎる)。左ペインの履歴に
              聞こえた文が残るので、化けた語をそのまま登録するのが確実
            </p>
          )}
          {tsu.sttMode === 'cloud' && (
            <label className="flex items-center gap-2 text-xs text-amber-400">
              ☁ 録音はOpenAIへ送られます。イヤホンマイク推奨。1日の上限
              <input
                type="number"
                className="w-16 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
                value={tsu.cloudMinutesPerDay ?? 60}
                min={0}
                onChange={(e) => save({ ...tsu, cloudMinutesPerDay: Number(e.target.value) })}
              />
              分
            </label>
          )}
          {/* M42-6: PC窓観測。神々の時計に載る(運営モードもONが必要)。
              取るのはウィンドウのタイトルとプロセス名だけで、スクリーンショットは撮らない */}
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={tsu.pcObserver === true}
              onChange={(e) => save({ ...tsu, pcObserver: e.target.checked })}
            />
            PC窓観測: 見ているアプリ名だけを記録(既定OFF・**画面は撮らない**・運営モードONが必要)
          </label>
          <label className="flex items-center gap-2 text-xs">
            1日の声かけ上限
            <input
              type="number"
              min={0}
              className="w-16 rounded border border-zinc-600 bg-zinc-800 px-1 py-0.5 text-xs"
              value={tsu.interruptBudgetPerDay ?? 5}
              onChange={(e) => save({ ...tsu, interruptBudgetPerDay: Math.max(0, Number(e.target.value) || 0) })}
            />
            回
          </label>
          <p className="text-[10px] text-zinc-500">
            静音時間 {(tsu.quietHours ?? { start: '23:00', end: '07:00' }).start}〜
            {(tsu.quietHours ?? { start: '23:00', end: '07:00' }).end} は自発的に喋らない
          </p>
        </div>
      )}
    </div>
  );
}

export function ConnectionsSection({
  config,
  saveConfig,
}: {
  config: AppConfig;
  saveConfig: (next: AppConfig) => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <UsageSection />

      {/* M28-3/M29-4: コミュニティレジストリ(作る前に探す) */}
      <div className="space-y-1">
        <p className="text-xs font-semibold text-zinc-300">コミュニティレジストリ</p>
        <p className="text-xs text-zinc-500">
          「作る前に探す」— エージェントが新しいツールを作る前にレジストリを検索し、
          コミュニティの既存プラグインがあれば提案する(承諾すると検証ゲート付きでインポート)。
          未達・候補なしのときは静かに従来の生成へフォールバックする。
          既定は公式レジストリ。社内レジストリ等のURLに変更もできる
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            key={config.registryUrl /* 「既定に戻す」での上書きを反映するため */}
            className="min-w-[12rem] flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1.5 font-mono text-xs"
            defaultValue={config.registryUrl ?? ''}
            placeholder="レジストリのベースURL(index.json をこの直下から取得)"
            onBlur={(e) => {
              const raw = e.target.value.trim();
              saveConfig({ ...config, registryUrl: raw });
            }}
          />
          <button
            className="shrink-0 whitespace-nowrap rounded border border-zinc-600 px-2 py-1.5 text-xs hover:bg-zinc-800"
            title={DEFAULT_REGISTRY_URL}
            onClick={() => saveConfig({ ...config, registryUrl: DEFAULT_REGISTRY_URL })}
          >
            既定に戻す
          </button>
        </div>
        <p className="text-xs text-zinc-500">空欄にすると検索無効(生成のみになる)</p>
      </div>

      <OwnerModeSection config={config} saveConfig={saveConfig} />

      <TsukuyomiSection config={config} saveConfig={saveConfig} />

      <RemoteAccessSection />
      <McpSection />
    </div>
  );
}

/**
 * M43-3(TUKU-yomi): 使うマイクを選ぶ。
 *
 * 既定(未指定)は Windows の既定デバイスになる。イヤホンを着けていても既定が内蔵マイクなら
 * 内蔵マイクを拾い、遠くの声を誤認識する(実機で「明日の予定は?」が「一番」になった)。
 * ラベルはマイク権限が無いと空になるので、一度権限を取ってから列挙する
 */
function MicPicker({ value, onChange }: { value: string; onChange: (id: string) => void }): JSX.Element {
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // ラベルを得るために一度だけマイクを開いて即閉じる(録音はしない)
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* 権限拒否ならラベル無しで並ぶ */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      setMics(
        devices
          .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d) => ({ id: d.deviceId, label: d.label || 'マイク' })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <label className="flex items-center gap-2 text-xs text-zinc-400">
      マイク
      <select
        className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Windowsの既定(内蔵マイクになることがある)</option>
        {mics.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
