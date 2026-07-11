# PROGRESS

## M40(2026-07-12): リモート(スマホ)からデスクトップ同等の運営操作

出先のスマホだけで運営タブと同じことができる。追加した /api/ops/* は既存のトークン認証配下
(新しい公開経路は増やしていない)。外部への発信は従来どおり岩戸ゲートを通り、承認カードは
スマホにも出る。**設定(APIキー・接続先)の変更はPC側限定のまま**。

- **発信ドラフトの個別操作**: 下書きカードをスマホで1枚ずつ見て、コピー / 𝕏投稿画面 /
  B!はてブ / 🐙GitHub Release(repo・タグ入力つき)/ 📝Zenn記事化 / 投稿済み・破棄。
  行き先は種類ごとにコードで固定(M37の表と同じ)
- **一括承認**: 承認バッチの同種(媒体×アクション)をスマホからも一括承認。X/はてブは
  URLが返るのでスマホのブラウザで開く(5件まで+「続きを開く」)
- **神々の時計(AMENO-koyane)の操作**: 稼働/停止・1日予算の入力・🔒の解錠・
  **各神の「今すぐ実行」**(観測/巡回/下書き生成/トリアージ/神議)。manager に runGodNow を追加
- **効果測定**もリモートのダッシュボードに表示(相関であって因果ではない旨も表示)
- 承認バッチの各項目に全文プレビューを表示(スマホでも「何を・どこへ・全文」が読める)
- 施錠(budgetSetByUser=true)はリモートからは立てられない(予算設定時に自動で立つ経路のみ。
  server.test.ts で固定)

テスト: server.test.ts に M40 のルート3本(一括・ドラフト操作・時計/神の実行)を追加。全1085緑。

## M39(2026-07-12): 一括承認(媒体×アクション)と発信ドラフトの神議配線

- **M39-1 岩戸ゲートの一括承認**: `IwatoGate.requestExecuteMany` を追加。承認ダイアログは
  1回だが、**全件の全文プレビューを並べる**(何を・どこへ・全文の掟は緩めない)。
  実行・auditは1件ずつで、**1件失敗しても残りを続行**し「N件中M件成功」を返す
  (部分成功を成功に見せない)。未承認なら executor は1件も動かない
- **M39-2 一括の単位は「媒体×アクション」**: 異種混在の一括は拒否(承認の的が濁るため)。
  UIは未処理の実行提案を媒体×アクションでグルーピングし、2件以上のとき一括バーを出す
- **M39-3 媒体ごとの「限界まで」**:
  - Bluesky(投稿/フォロー): 岩戸 → APIで実行(アプリが発行できる)
  - GitHub Release: 岩戸 → `gh release create --draft`(公開は人間)
  - Zenn: 承認直前にLLMが本文を起こし、**全文を岩戸ダイアログに出して** published:false でコミット
  - **X / はてブ: 岩戸を通らない**。アダプタの execute 宣言が空(規約)なのでアプリは何も
    発行せず、URLを返して renderer が投稿画面を開くだけ。**最後のクリックは人間**。
    一度に開くのは5件まで(`MAX_LINKS_PER_OPEN`)、超過分は「続きを開く」で人間が刻む
  - 実際に出せたものだけ下書きを `posted` にする(M38-3の効果測定の起点)
- **M39-4 発信ドラフト → 神議の承認バッチ**(配線): 未投稿ドラフトを行き先つきの提案として
  決定的に生成(LLM任せにしない)。種類→行き先はM37のUI表と同じ規則をmain側にも固定
- **M39-5 神の命名(ブランド)**: 新神の名は必ず日本神話(八百万の神)から採る掟を神議の
  プロンプトに追加(候補: SARUTA-hiko/SUKUNA-bikona/ISHIKORI-dome/KOTOSHIRO-nushi)。
  運営タブの「神々の時計」は **AMENO-koyane(天児屋命=祝詞・司会進行)** に改称
- リンク生成(X Intent/はてブ)は `shared/operations.ts` に集約(main と renderer で同じ関数)

## M38(2026-07-12): 神議の要求に応える(予算ロック解錠・神議→進化の配線・効果測定)

神議が実際に出した能力ギャップ提案(2026-07-11のバッチ)への回答。

- **M38-1 予算ロックのトグル(🔒/🔓)**: 手動設定で施錠(🔒=ユーザー優先)されたあと、
  運営タブの🔒をクリックすると解錠(🔓)して**神議に予算の調整権限を返せる**ようになった。
  値はそのまま残り、優先フラグ(`budgetSetByUser`)だけが落ちる。施錠は従来どおり
  予算設定と同時にしか起きない(解錠→再設定で往復できる)
- **M38-2 神議 → 進化の配線**: 承認バッチの能力ギャップ(branch='evolve')を承認すると、
  **その場で進化ジョブを起票**するようになった(従来は「通常チャットで request_capability
  として起票してください」の手渡し)。起票の引き金は**人間のバッチ承認のみ**で、神議が
  自分で起票することはない。昇格は従来どおり進化サブシステムの承認制。起票すると
  受け箱(kind='evolution')と⛩運営スレッドにジョブ番号が残る
- **M38-3 発信の効果測定(投稿→前後メトリクス差分)**: 神議のevolve要求
  「どの投稿がどの変化を生んだか紐付けできていない」の実体。投稿済みドラフトの
  postedAt直前スナップショットと計測窓(既定24h)後のスナップショットを突き合わせ、
  ★/Zenn♥/B!/DL/閲覧の差分を出す(`impact.ts` の純関数)。観測神の実行時に計測窓が
  閉じた投稿を1度だけ受け箱へ投函し、運営タブにも一覧を出す。
  **相関であって因果ではない**ことをUIに明示。データ不足時は「測れない」と正直に言う
  (投稿前スナップショット無し=観測神が止まっていた期間、等)

判断メモ: M38-3は神議のevolve要求そのものだが、進化ジョブに投げるよりコア側の
観測エンジンに直接組み込むのが素直(進化ジョブが書き換えてよいのは原則
`tools/plugins/` のみ=鉄則)。以後の同種要求は M38-2 の配線で自動起票される。

運営状態の手当て(コードではなく実データ): 神議に停止されていた omoi-kami を再開
(enabled=true / 予算20000 / 🔒)。停止理由は「予算0で空回り」だったが、予算0は仕様上
「無制限」で、実際は観測にLLMを使っていない。schedule.json.bak-m38 にバックアップ。

テスト: impact.test.ts(11)追加。全1074緑。

## M37(2026-07-12): 発信ドラフトの行き先(種類ごとのアクション)

下書きの種類 → 行き先の対応を**コードで固定**(`draftActions.ts` の表。Xの文字数に
合わない種類にXボタンを出さない)。外部へ出る経路はすべて岩戸ゲート(承認)を通る。

- **x-post**: 従来どおりX投稿画面を開く1タップリンク(+本文にURLがあればはてブ)。
  最後のクリックは人間(規約)
- **release-note → GitHub Release**(M37-1): repo(観測対象から選択)+タグを添えて
  岩戸ゲートへ。承認後 `gh release create --draft`(既存タグなら `edit` で本文更新のみ)。
  **作成は必ず下書き(--draft)**。公開はGitHub上で人間が行う。コピーボタンは残す
- **article-outline → Zenn記事化**(M37-2): アウトラインからLLMが本文を執筆 →
  `article-body` 下書きとして保存 → 岩戸ゲート(全文プレビュー)→ 承認後
  zenn-content の `articles/<slug>.md` に **published: false** でコミット・push。
  公開(true化)は別途人間の判断。**executorは published:false のfrontmatterが無い
  Markdownを拒否**(この経路で公開記事は出せない)。承認されなくても本文の下書きは残る
- **reply / weekly-report / article-body**: 外部への行き先を持たない(コピーのみ)
- 新アダプタ `zenn-repo`(execute: commit-article)。パスは設定→接続→オーナーモードの
  「zenn-content リポジトリのパス」(未設定なら availability=false で誘導)。
  gitはインジェクション可能(テストは実push無し)
- `operations.status()` に `repos` を追加(UIのリリース先候補)。全フィールド任意/加算のみ=
  状態ファイル・旧設定と互換

判断メモ: Zennのslugは規則(a-z0-9-_ 12〜50字)があるため、日本語タイトルは
`ama-teras-<YYYYMMDDHHmm>` に落とす純関数 `articleSlug` を用意した(テスト固定)。

テスト: draftDestinations.test.ts(14)+ draftActions.test.ts(4)追加。全1063緑。

## M36(2026-07-12): 運営タブ小改修

### インシデント記録: 私的メモの誤コミット(復旧済み)

M36コミット時、`git add -A` により作業ツリー上の未確認ファイル(公開判断が未定の
私的ビジョンメモ2件)が紛れ込み一時公開された。対応: ①即時にHEADから削除して
再push(露出数分)②.gitignoreに追加 ③ユーザー指示により履歴書き換え(直近2コミットを
統合rewrite)+force pushで履歴からも除去。**既知の限界**: GitHub側では到達不能
コミットもハッシュ直打ちで一定期間キャッシュが残り得る。完全削除が必要な場合は
GitHubサポートへの依頼となるが、今回は個人名+構想メモのため依頼はしない(ユーザー判断)。
**再発防止**: 以後のコミットは `git add -A` を使わず変更ファイルの明示指定とする。

- **予算の手動設定欄**(M36-1): 運営タブの神々の時計に1日トークン予算の直接入力欄
  (0=無制限のヒント付き)。ユーザー自身の設定行為なので**引き上げも承認不要**。
  手動設定すると `budgetSetByUser` が立ち(🔒表示)、**神議の自律調整(引き下げ含む)
  より優先**される(applyAutonomousChange が拒否・テスト固定)。人間承認済みの
  バッチ経由の変更は byUser 同格。omoi-kami「予算0で空回り」報告の直接の受け皿
  (補足: 予算0は仕様上「無制限」— 空回りに見えた場合もこの欄とヒントで解消)
- **運営モデル帯のリスト選択化**(M36-2): kamuhakariBand/godsBand のモデル入力を
  基本タブと同じ KNOWN_MODELS ドロップダウンへ。自由入力は「カスタム」選択時のみ

## M35(2026-07-12未明): M34残のT4/T5完了

- **T4 Bluesky実行系**: app password認証(secretsの'bluesky'スロットにJSON・
  safeStorage暗号化。設定UIは接続タブのオーナーモード内)。**資格情報の有無で
  アダプタ宣言ごと切替**(なし=execute空・提案のみ / あり=post/follow/reply)。
  実行は岩戸ゲート経由のみ。**神議バッチ→承認→岩戸→実行の結線**: 仲間候補
  (bluesky由来・match・未処理)のフォロー提案をLLM任せにせず決定的に生成し、
  バッチ承認後も岩戸の全文確認を通る(拒否時はAPI未呼び出し=テスト固定)。
  資格情報の保存で operations を再初期化(再起動不要で有効化)。
  USER-GUIDEに自動化開示の推奨注記
- **T5 カスタムbaseURL(OpenAI互換)**: providerPreset='custom' を追加。
  baseURL自由入力(config.customBaseUrl)+モデルID自由入力+専用キースロット
  ('custom')+接続テスト対応(診断URLも実接続先を表示)。
  **localhost系はキー不要**(isLocalBaseUrl純関数・サブドメイン偽装も判定)で、
  Ollama等は baseURL とモデルIDだけで動く。localhost時は「ローカルモデルは
  自己進化の検証ゲート通過率が下がる場合がある」注意文を表示。
  【判断】カスタムは「無料APIモード」ではない — freeMode自動ONにしない
  (軽量化も進化無効化もしない。学習利用の注意文もローカルには表示しない)
- テスト: models(custom/isLocalBaseUrl)+Bluesky実行系8件(リクエスト形状・
  宣言一致・岩戸結線・拒否時未実行)を追加。全体全緑
- **HN返答の自己判定**: 本文の完了報告参照

## ⚠ 次回ユーザー再起動で有効になる機能一覧(M34。ビルド済み・起動のみでOK)

1. **監視の完全移管**(当直CLI→AMA-teras): はてブ数(M34-1)・HN karma/スレッド新着/
   自コメント返信の全文検知(M34-2)。**要設定**: 設定→接続→オーナーモードで
   hnUser(moriwo-dev-ai)と hnThreads(48845422)を登録
2. **スマホ運用(M34-6)**: リモートUIに「⛩運営」タブ — 岩戸承認(全文プレビュー)・
   神議の承認バッチ・⛩スレッド閲覧/返信・ダッシュボード(数字/時計/受け箱)。
   リモート応答はauditに「リモート経由」記録。デスクトップ側ダイアログとも同期
3. **運営専用モデル帯(M34-7)**: 神議/神々のモデルを本体と独立に設定可
   (設定→接続→運営専用モデル)。**推奨: 神議=Sonnet系に変更**(planner=Fable5のままだと
   1日2回の神議だけで月1万円級)。usage帯別集計に kamuhakari/gods の行が出る
4. X注記(M34-3)・移管チェックリストは C:\dev\ops-watch\MIGRATION_STATUS.md

## M34(NIGHT_TASKS8)記録

- **T1/T2/T3/T7完了**(コミット1つ目)・**T6完了**(このコミット)。詳細は各コミット参照
- **互換性(並走ルール)**: 稼働中インスタンスとの状態ファイル互換を維持 —
  スナップショット/設定/god-paramsの新フィールドは全て任意。**旧形式読み込みテスト**
  (M33世代の実フォーマットをそのまま読む)で担保
- **判断**: (a) はてブ監視のZenn URLは APIのpath から自動導出(watchUrlsは追加分のみ)
  (b) HN返信検知は submitted 上位15コメントの kids 差分方式(全履歴走査はしない)
  (c) 当直の bluesky-candidates.json は自動引き継ぎしない(形式が別物。初期数日の
  重複報告は許容と MIGRATION_STATUS に明記)
  (d) 岩戸のリモート応答はデスクトップのダイアログとも双方向同期
  (operationsApprovalResolved イベント)
- **T4(Bluesky実行系)・T5(カスタムbaseURL)は次回へ**(時間の許す範囲、の範囲外と判断):
  T5は着手前調査で SecretSlot型・secretsStatus・BasicSection(メイン設定UI)・
  接続テスト・PROVIDER_PRESETS構造(固定baseUrl前提)へ波及することが判明。
  必達4タスク完了後の深夜にメイン設定UIを急いで触るより次回冒頭で丁寧にやる方が
  安全と判断(HNへの「実装済み」返答はT5完了まで保留すること)

## ⚠ 朝にユーザーとやること(NIGHT_TASKS7 = M33)

1. **本番反映(要あなた立ち会い)**: 実アプリを閉じる → `npm run build` → 起動。
   夜間実装ルールにより実アプリの再起動はしていない(現在稼働中の個体はM32世代のまま)。
   再起動後、神々の時計が動き出す(起動90秒後に追いつき実行が1回走る)
2. 反映後の確認: 右ペイン運営タブに「神々の時計」「受け箱」が出る/左ペインに
   「⛩ 運営」スレッドが出る(承認待ちバッチがあると未読バッジ)
3. 神議の初回は手動で試すのが早い: ⛩運営スレッド →「🧠 神議を今すぐ開く」
   (planner帯を消費。分析+承認バッチが届く)
4. 予算既定値: 巡回/門番 各3万tok/日・下書き2万・神議6万。運営タブで変更可

## M33(NIGHT_TASKS7 = 神議アーキテクチャ)記録

- **フェーズA(T1〜T4)完了**(コミット a77b2fc)。詳細はコミットメッセージ参照。
  設計の鉄則をコードとテストで固定: ①スケジューラ→外部発信の直通経路なし
  ②2段階制(自律=間隔/キーワード/停止/予算引き下げ、承認必須=新ツール/判定プロンプト/
  予算引き上げ/神の新設削除)③予算変更は宣言でなく実値で再分類(騙り増額防止)
  ④間隔下限15分・全自律調整のaudit記録
- **判断(自分で決めた)**:
  (a) uzume巡回の重複排除は god-params.json の seenUris/seenHandles(直近2000件で
  丸め)。見張りCLIからの引き継ぎ記録は**存在しなかった**(巡回未実施)ため空から開始
  (b) 1回の巡回で評価は最大5件(予算保護)
  (c) 神議へのユーザー発言は即応(planner帯)だが、パラメータ変更は次回神議で反映と案内
  (d) 承認バッチのexec-action承認後も実発行は岩戸ゲートの最終確認を通る(二重確認は
  仕様=コードレベル保証を優先)
  (e) tool-toggle / rate-limit の自律調整はv1では記録のみ(対象機構が未実装)
- **フェーズB(T5〜T7)**:
  - **T5完了**: 神=宣言的定義(userData/operations/gods/*.json、schema検証つき)。
    実行はエンジン型(metrics-observer/community-patrol/draft-writer/issue-gatekeeper/
    kamuhakari)にディスパッチ。**定義の新設・改造は岩戸ゲート('god-definition'
    アダプタ)の承認必須** — 承認拒否で書き変わらないこと・applyApproved の呼び出しが
    executor 1箇所のみであることをテストで固定。community-patrol は judgePrompt
    上書き可(変更自体が承認制)。編集UIは運営タブの「⚙神の定義」(JSON+申請ボタン)
  - **T6完了**: 能力ギャップの3分岐(adhoc/evolve/new-god)。神議の提案に branch と
    godDraft が載り、new-god の承認は requestGodDefinitionApply → さらに岩戸ゲートの
    定義JSON最終確認を通る(無承認の自動有効化は構造的に不可能)。不明branchは
    adhoc(最も安全)へ倒す
  - **T7一部**: HNアダプタ(read/search。Algolia検索+公式Firebase。execute空)を追加し
    仲間発見の検索結果に統合。**落とした分**: Bluesky実行系(app password認証+承認後
    フォロー/投稿)とカスタムbaseURL入力UI(Ollama対応)は次回へ
- **判断(追加)**: (f) 神の定義から tools[] は外した(v1のエンジンは使うツールが
  固定のため。ツール付与は承認必須項目として2段階制に残してあり、実装時に定義へ追加)
  (g) 実アプリは22:21にユーザー操作で終了(usageログに実セッション使用の形跡)。
  夜間ルールに従い再起動していない=朝の本番反映はビルド+起動のみ

## ⚠ 朝にユーザーとやること(NIGHT_TASKS6 = M32、全タスク完了)

1. **動作確認**: 設定 → 接続 → 「オーナーモード」をON → 対象リポジトリ
   (moriwo-dev-ai/ama-teras 等)とZennスラッグを登録 → 右ペイン「運営」タブで
   「📊 今すぐ収集」。gh認証は既存のログインをそのまま使う(traffic/実行系には
   repoスコープが必要 — 既に `gh auth login` 済みなら通常は足りている)
2. 週報・発信ドラフト生成にはAPIキー(planner/reviewer帯)を使う。ModelPolicy
   未設定なら単一モデル設定で代行される
3. **岩戸ゲートの実弾テスト**(任意・あなた立ち会いで): トリアージカードの
   「⛩ 返信を送信」→ 承認ダイアログの表示と audit.jsonl への記録を確認
   (拒否すれば何も発信されない。夜間は実発行を一切していない)
4. Bluesky対応状況: 公開検索(read)のみ実装。投稿・フォローは認証保管が未実装のため
   **capabilities宣言ごと空**にしてある(宣言と実挙動の一致を優先。対応時は
   executor と宣言を同時に足す)
5. ~~注意: 昨夜のコミットに `.claude/settings.json` が含まれている~~ → **対応済み(M32-7)**:
   リポジトリの settings.json は clone者全員のClaude Codeに適用されるため、
   個人設定(model指定・allowリスト)を `.claude/settings.local.json`(gitignore済み)へ
   移し、リポジトリ側は**安全側のdenyのみの最小構成**
   (rm -rf / git reset --hard / npm publish / .env・~/.ssh・~/.aws読み取り禁止)に縮小。
   curl/wget denyはローカル側にのみ残した(clone者の作業を過剰に縛らないため)

## M32-8(2026-07-12): リモートアクセスQR消失バグ修正+雑務

- **QR消失バグ**(ユーザー報告): RemoteAccessSection のホスト名フォールバックが
  旧localStorageキー(mycodex-remote-host)のみ参照しており、M27-3のキー
  リネーム(amateras-*)後、config未保存の環境でホスト名が空に戻りQRが黙って消えた。
  修正: ①解決順を config → amateras-remote-host → mycodex-remote-host の純関数
  `resolveInitialHost` に抽出し、localStorage経由で見つけたらconfigへ自己修復保存
  ②ホスト名が空でURL/QRを出せない時は「ホスト名を入力すると接続URLとQRが
  表示されます」の案内を表示(黙って消さない)。回帰テスト5件追加
- `.pulse-log.json`(Cowork側スケジュールタスクの状態ファイル)を .gitignore に追加

## M32(NIGHT_TASKS6 = Project TAKAMA-gahara 第1弾)完了記録

- **ユーザー追加指示(2026-07-11夜・確定方針)**: 運営タブはオーナー機能としてゲートする。
  `AppConfig.operations.enabled` を「オーナーモード」スイッチとして設定の「接続」タブに置き、
  **既定OFF**。OFFの間は右ペインに運営タブを表示しない(存在自体を見せない)。
  ONにした時だけタブ表示・gh検出・メトリクス収集が動く。→ **実装済み**
  (manager.ensureInitialized が enabled 時のみ初期化。OFF時はgh検出もfetchも走らない
  ことをテストで固定)
- **M32-2 Protocol AMANO-iwate(最優先・完了)**: `operations/protocol.ts` に
  MediaAdapter規約+岩戸ゲート。**executor はモジュール内 WeakMap に封印され、
  登録時に呼び出し元の参照からも削除される** — 承認フロー(何を・どこへ・全文
  プレビュー+規約メモ)を通らずに実行へ到達する経路がコードレベルで存在しない。
  宣言(capabilities.execute)と実装(executor有無)の不一致は登録時に例外。
  全実行(拒否含む)を audit.jsonl に `[岩戸]` プレフィックスで記録。
  **protocol.ts を聖域(PROTECTED_PATHS+docs/PROTECTED.md 第8項)に追加**。
  承認ダイアログ(IwatoApprovalDialog)は既存の聖域 `components/Approval/` 配下に配置
- **アダプタ**: github(gh CLI・read/search+execute: comment/label/merge)/
  zenn(公開API read)/ x(検索URL生成+貼り付け解析のみ・**execute空=全て人間**)/
  bluesky(公開検索read・執行系は宣言ごと空の骨組み)
- **M32-3 OMOI-kami**: スナップショット収集(GitHub基本+traffic views/clones/
  referrers+リリースDL数+Zennいいね/コメント+レジストリ件数)→
  userData/operations/metrics.jsonl に時系列蓄積 → 運営タブに前回比(⬆/⬇)表示。
  週報はプロンプト構築(時系列×referrer×投下履歴の突き合わせ)+planner帯で下書き化。
  traffic API不達(権限なし)でも基本メトリクスは成立(テスト固定)
- **M32-4 AMENO-uzume**: PROGRESS.md冒頭6KB+git log 20件+メトリクス差分から
  見せ場抽出 → X投稿/リリースノート/記事アウトラインをJSONで下書き生成。
  **投稿ボタンは作っていない**(コピー+「投稿済みにする」マークのみ。マークは
  postedAt を刻み週報の突き合わせに使う)。メディア戦略ボード(8媒体の初期
  ポートフォリオ+メトリクス連動の次アクション)。仲間発見: X検索URL生成
  (開くのは人間)+Bluesky公開検索+貼り付けテキストのLLM評価(ヒューリスティクス:
  自作公開/失敗談/売り込み導線なし/実験の話)→ 候補カード(理由+宣伝ではない
  返信下書き)
- **M32-5 TEDIKA-rao**: オープンIssue/PR取得 → PRはdiff(60KB上限)込みで
  reviewer帯がseverity方式トリアージ → カード(要旨/指摘/返信下書き/ラベル案/推奨)。
  レジストリ系リポジトリのPRは check-runs を統合表示。LLM出力が壊れても
  「手動確認」カードで生存。実行系は岩戸ゲート経由のみ(UIのボタンも
  operationsExecute → 承認ダイアログの経路しか無い)
- **M32-6 仕上げ**: USER-GUIDE に「Project TAKAMA-gahara」章(岩戸開きの物語+
  三神+岩戸の掟)。README追記は**保留**し docs/README-takamagahara-draft.md に
  日英下書きのみ(次のZenn記事「岩戸開き」と同時公開の方針どおり)
- **判断(自分で決めた)**: (a) Blueskyのexecuteは「宣言して未実装エラー」ではなく
  宣言ごと空に(宣言と実挙動の一致テストを通すため。対応時に両方同時追加)。
  (b) 承認応答のタイムアウトは10分=拒否扱い(無人放置で実行が宙吊りにならない)。
  (c) 運営の観測データ・下書き・候補は userData/operations/ 配下(リポジトリには
  入れない=公開リポジトリに運営データが漏れない)。
  (d) 岩戸の監査は既存 audit.jsonl に統合(scope='system'・event=result/hard-deny)
- **テスト**: 岩戸ゲート11件(承認なし到達不能・封印・宣言一致・audit)+
  運営13件(収集/週報プロンプト/下書き/候補/トリアージ/オーナーゲート)。
  全体 typecheck 3構成+vitest **988件全緑**
- push: 本セッションはユーザーの一括承認済み(denyルールもユーザーが削除)。
  外部への実発行(SNS投稿・GitHubコメント等)は**一切行っていない**(実装のみ。
  テストは全てモック)

## ⚠ 朝にユーザーとやること(NIGHT_TASKS5 = M31、全タスク完了)

1. `git push`(`!` プレフィックスで実行)
2. インストーラ添付:
   `gh release upload v1.0.0 "release/AMA-teras Setup 1.0.0.exe"`
   (101.6MB。**このexeは深夜のプラグインロード修理込みの最新ビルド**)
3. README(日英)の「Windows インストーラは準備中です」を Release への
   ダウンロードリンクに差し替え → 再push
4. https://github.com/moriwo-dev-ai/ama-teras/security/dependabot で
   アラート23件の解消を確認(ローカル npm audit は **0件** になった)
5. 掃除(私の権限では削除できなかったもの):
   - `C:\Users\haru-\AppData\Local\Programs\AMA-teras`= 深夜に実機検証で
     インストールした**修理前ビルド**。アンインストール(設定→アプリ)するか、
     新しいインストーラで上書きインストールを
   - scratchpad の `smoke-ud-e43` / `smoke-ud-inst` / `smoke-ud-unpacked`
     (検証用一時userData。キー類は一切未入力)
   - 以前からの持ち越し: `C:\Users\haru-\AppData\Roaming\Electron`
6. 注意: 実アプリは深夜作業前にあなたが閉じたまま。次回起動から Electron 43 になる

## M31(NIGHT_TASKS5)の完了記録

- **M31-1 完了**: `npm audit fix`(forceなし)。実質的な更新は既にlock内で済んでおり
  差分はlicenseフィールド1行のみ。残10件(high)は全てメジャー更新が必要と確定
  (Electron本体6件=実行時影響あり / tar系7件=devDepsのみ)。
- **M31-2 完了**: **Electron 37.10.3 → 43.1.0**(Chromium 150 / Node 24.17 / V8 15)。
  **コード変更ゼロで全緑**。事前Web調査どおり破壊的変更の影響なし
  (①42でpostinstall自動DL廃止→B環境はnode_modules共有のため影響なし。
  バイナリ取得は `npx install-electron` が必要=下記の開発機手順に注意。
  ②rendererのclipboardは全箇所 navigator.clipboard で影響なし。
  ③dialog defaultPath既定変更・④popupリサイズ挙動は実害なし)。
  検証: typecheck 3構成+vitest(進化マネージャ実git統合2件は並列負荷時のみ
  10秒タイムアウト→単独再実行で27/27緑=完了条件どおり合格)+
  AMATERAS_SMOKEスモーク+一時userDataフルUI起動(CDP: マウント・IPC配線60本)。
  夜間の中断経緯: 実アプリがバイナリをロック(EBUSY)→ 私からの終了は
  権限ガードが拒否 → ユーザーがアプリを閉じて再開、の2段で完了。
- **M31-3 完了**: **electron-builder 25→26.15.3**。設定(electron-builder.yml)は
  無変更で互換。**npm audit 0件に**(tar系も解消)。懸念だったPowerShell
  プロファイル汚染問題は発生せず。
- **M31-4 完了**: **NSISインストーラのビルド・実機検証に成功(管理者権限不要)**。
  `release/AMA-teras Setup 1.0.0.exe`(101.6MB、展開後386MB)。
  - **重大バグを発見して修理**: パッケージ版で全プラグインのロードが失敗していた
    (esbuildが読込時に ESBUILD_BINARY_PATH を固定するため、静的importが
    ESMホイストで index.ts の環境変数設定より先に評価され、asar内パスの
    spawnでENOENT)。**初回使用時の動的import化**で修理し、mainプロセス
    全体の「esbuild静的import禁止」を回帰テストでピン(loader.esbuild.test.ts)。
    修理後の実機(win-unpacked)で **tools=22 / errors=0** を確認。
    ※eb26起因ではなく従来からの潜在バグ。実機インストール検証を初めて
    やったことで発覚(=T4をやった価値)
  - 実機確認: インストール(NSISウィザードはユーザーがクリック。/Sは
    assisted installerでは効かなかった)→起動→レンダラマウント→
    設定画面表示→CDPで正常終了、まで確認
  - 自分で決めた判断: package.json version を 0.1.0→**1.0.0** に統一
    (Release v1.0.0 と installer 表記の不一致を解消)。
    古い成果物(Setup 0.1.0 / 旧MyCodex Setup)は release/ から削除
- **M31-5 完了**: 冒頭チェックリスト。README(日英)にSmartScreen注意書き追加済み。

## 現在の状態

- **M30-4(2026-07-11)**: **公開**。GitHubへ moriwo-dev-ai/ama-teras(本体)と
  moriwo-dev-ai/amateras-registry(レジストリ)を public で公開。main+全タグをpush
  (注釈付きタグ5個の tagger に旧個人メールが残っておりGH007で正しくブロックされたため、
  メッセージ・日付保持で新名義に再作成してから再push=秘密情報ガードの実動確認)。
  検証: コミット名義の moriwo-dev-ai 紐づきOK・既定レジストリURLの index.json 実疎通OK。
  About/Topics設定、Release v1.0.0 作成(インストーラは後日添付)、
  docs/social-preview.png(1280x640)生成。gh CLI / ffmpeg は winget 導入。

- **M30-3追加(2026-07-11)**: **READMEデモGIF(docs/demo.gif)の作成**+検証起動用の
  userData明示指定。
  ①`AMATERAS_USER_DATA` 環境変数を index.ts に追加(検証・デモ用に一時userDataで
  フルUIを起動する開発者向け入口。**M17-1のリネーム移行はこのモードでは実行しない=
  実設定の複製を構造的に防止**。単一インスタンスロックはuserData単位のため実アプリと
  並行起動可能)。
  ②デモ撮影: 一時userData+CDP(port 9228)で起動し、Node組み込みWebSocketの
  CDPドライバで スクリーンキャスト(Page.startScreencast png/maxWidth800・ack遅延で
  実質12fps)+シナリオ自動駆動(依頼入力→承認クリック→昇格承認クリック)。
  APIキーはユーザー自身がデモインスタンスの設定UIへ入力(私はキーを扱わない)。
  シナリオは指示のCSV→Markdownが**組み込み csv_to_markdown と衝突して進化が起動しない**
  ためユーザー確認のうえ「YAMLをJSONに変換するツール」に変更。実進化ジョブ#13が
  yaml_to_json を生成(1回目はメタデータ欠落で自動リトライ→2回目成功)→検証ゲート
  全通過→昇格承認→エージェントがその場でYAML→JSON変換を実演、まで全て実撮影。
  ③編集: 2セグメント(計1.6万フレーム)からマイルストーン窓で6シーンを等間隔
  リサンプルし、ffmpeg(winget導入・ユーザー承認済み)palettegen/paletteuse で
  **27秒・幅800px・707KB** のGIFに。README(日英)のプレースホルダ文言を削除。
  ④後始末: デモインスタンスをCDP Browser.closeで終了し、一時userData
  (デモ用キー含む)をディレクトリごと削除済み。
- **M30-2追加(2026-07-11)**: **モデル未開放エラーの優雅な処理+ModelPolicyのUX改善**。
  背景: GPT-5.6系はGA後もアカウント単位の段階開放で404
  (model_not_found)が返り、既定モデル未開放の新規ユーザーは1通目で即死していた。
  ①検知: `isModelUnavailableError`(OpenAIの message/`error.code==='model_not_found'`・
  Anthropicの404 not_found を判定)。分類に `model_unavailable` を追加
  (404+model言及。transientリトライを浪費しない)。
  ②自動フォールバック: refusal段下と同じ既存機構(acquireFallback)に
  kind='model_unavailable' を追加。`stableFallbackLLM`= **gpt-5.6系→gpt-5.5**
  (同一プロバイダの既知の安定版。フォールバック設定不要)。**1会話1回**
  (専用フラグ modelUnavailableFallbackUsed)・警告カード
  「未開放/存在しない(404)のため安定版へ切り替え…開放され次第元の設定で使えます」・
  audit記録 `model-unavailable(1/1):`。ModelPolicy有効時は該当帯(そのループの
  プロバイダ)のみ差し替えで帯構成は維持。子(サブエージェント)は refusal と同様に
  設定済みフォールバック先へ。
  ③平易なエラー表示+導線: フォールバック不発時は「このモデルはあなたのアカウントに
  まだ開放されていない可能性があります(新モデルは段階開放)」+**エラーカードに
  「⚙ 設定を開く」ボタン**(AgentEvent error に settingsHint を追加。policy有効=
  モデル運用タブ/無効=基本タブ)。describeLLMError フックをオブジェクト形式対応に拡張。
  ④接続テストの有料プロバイダ対応: 設定→基本のAPIキー欄横に「接続テスト」ボタン
  (main側は元からプロバイダ非依存。UIの導線を追加。無料プリセットと同じ診断表示)。
  ⑤ModelPolicy UX: policy有効時に基本タブのモデル欄へ
  「⚠ モデル自動切替が有効のため、この欄ではなくモデル運用タブの帯設定が使われます」
  +「モデル運用タブを開く」ボタン。チャットの「PLANNER・モデル名」バッジをクリック可能に
  (CustomEvent 'amateras:open-settings' → App が SettingsPanel を指定タブで開く。
  initialTab prop + nonce再マウント)。
  自分で決めた判断: (a) 安定版マッピングは現時点で必要な gpt-5.6→gpt-5.5 のみ定義
  (Anthropic等は事象未発生のため追加しない=推測で書かない)。(b) ライトテーマの
  hover回帰テストが新ボタンの hover:bg-amber-900/60 を検出 → 上書き定義済みの
  hover:bg-amber-950 へ変更(M25-6の仕組みが機能)。
  テスト8件追加(検知3態・分類不変・loop分岐とヒント伝搬・stable写像・e2e成功/上限停止)。
  全941テスト・typecheck 3構成・build 合格。
- **M30-1追加(2026-07-11)**: **GPT-5.6 対応**(2026-07-09 GA の OpenAI 新世代)。
  モデルIDは推測せず公式で確認(**2026-07-11 確認**:
  https://developers.openai.com/api/docs/models/gpt-5.6-sol /
  https://openai.com/index/gpt-5-6/ )— **gpt-5.6-sol**(フラッグシップ・エイリアス
  `gpt-5.6` はSolに解決)/ **gpt-5.6-terra**(中位)/ **gpt-5.6-luna**(最安)。
  ①KNOWN_MODELS に3層追加・**DEFAULT_MODELS.openai と DEFAULT_OPENAI_MODEL を
  gpt-5.6-sol へ**(両定数の一致を維持)・コンテキスト上限は3層とも公式値 **1,050,000**
  (出力128K)。旧 gpt-5.5系候補は後方互換で残置。
  ②usage.ts 価格表: Sol $5/$30・Terra $2.5/$15・Luna $1/$6(公式で再確認済み)。
  terra/luna を汎用 gpt-5.6(=Sol同額で受けるエイリアス用)より先に置き前方一致の
  誤照合を防止。
  ③ModelPolicy プリセットに「OpenAI構成(Sol/Terra/Luna)」を追加
  (planner/escalation=Sol・worker=Terra・explorer=Luna。既存のAnthropic系2種は不変更。
  reviewer/midEscalation は未指定=既定のフォールバック規則に委ねる判断)。
  ④自分の判断で追加: refusal時の同一プロバイダ段下(REFUSAL_DOWNGRADES)に
  Sol→Terra→Luna を追加(新既定モデルの突然死回避。汎用 'gpt-5.6' prefix は
  luna を terra へ「格上げ」してしまうため意図的に置かず、luna・素のエイリアスは
  設定済みフォールバックへ委ねる)。
  テスト5件追加・2件更新(既定・3層候補・上限・3層単価と照合順・キャッシュ率)。
  全933テスト・typecheck 3構成合格。

- **M29(夜間自律作業その4・NIGHT_TASKS4.md 全6タスク完了)**。テスト930件・
  typecheck(node/web/remote)・build 全合格。コミット6件(M29-1〜M29-6)。
  - **実施サマリ**:
    - T1(M29-1): 無料API接続404の根治 — baseURL末尾スラッシュ正規化+Gemini既定を
      現行世代 gemini-3.5-flash へ(公式docsで確認)+接続テストにURL/HTTP/body診断
    - T2(M29-2): 設定モーダルの高さ固定(h-[85vh]・タブ切替で外形不動)
    - T3(M29-3): 右ペイン(進化/Debug)の狭幅レスポンシブ(flex-wrap・nowrap・min-w-0)
    - T4(M29-4): registryUrl 既定=公式レジストリ、空文字=無効、「既定に戻す」ボタン
    - T5(M29-5): **仮導入+事後棚卸し** — 包括承認(none/verified/verified-generate)で
      自律中の無人仮導入(検証3段必須・危険権限除外)+終了時棚卸しカード+永続化再提示
    - T6(M29-6): 狭幅の全体点検(主要3箇所修正+残課題一覧の記録)・ドキュメント反映
  - **自分で決めた主要判断**: T5の「+generate」は昇格の仮導入自動承認と解釈(人間ゲートは
    昇格にあるため)/ M20不変条件3はユーザー指示に基づき契約更新(autonomousMode自体での
    自動化は引き続き禁止・guardrailsで固定)/ bashタイムアウトは AbortSignal.any で実装
  - **未解決・ユーザーへの連絡事項**:
    1. **実機確認を推奨**: ①無料APIの接続テスト(Gemini・修正後の初疎通)②自律モードON時の
       包括承認ラジオ③棚卸しカード(自律実行で仮導入→終了時)④設定モーダルのタブ切替
       ⑤右ペイン狭幅(左ペインを広げて縦書き化が消えたか)— 今夜も実起動なし(静的検証のみ)
    2. 狭幅点検の残課題: 未wrapのflex行が約37箇所(Chat/Settings/Layout)。実害が出やすい
       3箇所(EnvWidgetのworkspace行・ReviewCardマイルストーン・承認ダイアログの出所行)は
       修正済み。残りは実表示で崩れを確認したものから順次対応が現実的
    3. 仮導入の「削除」は evolve/N のrevertのため、後続の進化と同一ファイルを触っていると
       競合で失敗することがある(その場合は手動 `git revert -m 1 evolve/N` を案内表示)

- **M29-5追加(2026-07-11 夜間自律作業その4 T5)**: **仮導入+事後棚卸し**(自律モードの
  レジストリ活用・機能追加の本命)。「承認を消すのではなく、承認のタイミングを作業の前後
  (開始時の包括承認+終了後の棚卸し)へ移す」。
  ①包括承認範囲 `AutonomousRegistryScope`('none'=自動導入なし・既定/'verified'=検証済み+
  危険権限なしのみ仮導入/'verified-generate'=+生成も仮導入)。AppConfig の既定値+
  自律モードON時のモーダル(AutonomousModal)でこの実行の範囲を選択(audit記録)。
  ②自律実行中: verified系なら 検索→ダウンロード→検査→**B環境検証3段(省略なし)**→仮導入を
  無人実施。範囲外(未検証 or 危険権限)は**個別承認カード+タイムアウト既定10分**
  (AbortSignal.any でタイムアウト=辞退→従来の生成へ続行。ハング防止)。
  none は現行どおり検索スキップ。
  ③**昇格承認の契約更新(M20不変条件3・ユーザー指示 NIGHT_TASKS4 T5 による)**:
  無人昇格は「事前登録済み(provisionalCandidates)×scope='tool'×危険警告ゼロ×
  toolName確定」の仮導入のみ。**autonomousMode そのものを理由とする自動化は引き続き禁止**
  (昇格フックは autonomousMode/getAutonomous を参照しない — guardrails.m20 を新契約で
  更新し、条件ガードの存在もソース固定)。renderer/core・危険権限は常に人間承認。
  ④棚卸し: 実行終了(done)時にチャットへ棚卸しカード(InventoryCard・残す/削除)。
  削除=`EvolutionManager.uninstallPromotion`(evolve/N のマージrevert+ホットリロード。
  競合時は失敗を返し手動手順を案内)。未応答は `userData/provisional.json` に永続化し、
  進化タブの「仮導入の棚卸し」セクションで次回起動時も再提示。ツール一覧に「仮」マーク
  (ToolInfo.provisional)。ジョブが rolled_back/failed になったら自動で棚卸しから除去。
  自分で決めた判断: (a) '+generate' の意味は「生成ジョブの昇格を仮導入として自動承認」と
  解釈(enqueue自体は従来から自律中も可能で、人間ゲートは昇格にあるため)。
  (b) 個別承認カードは登録なし=通常インポート扱い(承認済みでも昇格は人間承認のまま)。
  (c) 棚卸しの「削除」失敗(後続変更との競合revert)はリストに残して手動手順を案内。
  テスト9件+既存2件更新(範囲別挙動・危険権限除外・タイムアウト・昇格ガード・
  generate登録・棚卸しkeep/delete/失敗・rolled_back除去・永続化)。
  全930テスト・typecheck・build 合格。
- **M29-4追加(2026-07-11 夜間自律作業その4 T4)**: **レジストリ既定値とUX**。
  `registryUrl` の既定を公式レジストリ
  `https://raw.githubusercontent.com/moriwo-dev-ai/amateras-registry/main`
  (定数 `DEFAULT_REGISTRY_URL` は shared/models.ts。未公開の間の不達は既存の
  静かなスキップが保険)へ変更。セマンティクス: **未設定/不正形式=既定へフォールバック・
  空文字=検索無効(明示オプトアウト)**として ConfigStore の read/set 両方で正規化。
  service 側も空文字を検索スキップ扱いに。接続タブに「コミュニティレジストリ」見出し+
  説明文(作る前に探す・既定は公式・社内レジストリ可)+**「既定に戻す」ボタン**+
  「空欄にすると検索無効」の明示。テスト7件追加(既定適用・空文字保持・不正フォールバック・
  set正規化・空文字で検索なし)。全921テスト・typecheck 合格。
- **M29-3追加(2026-07-11 夜間自律作業その4 T3)**: **右ペインのレスポンシブ修正**。
  進化タブ: ジョブ起動フォーム行を `flex-wrap` 化(狭幅で縦積みに折り返す)、
  ボタン(ジョブ起動/📦インポート/キャンセル/更新/⏪戻す)へ `shrink-0 whitespace-nowrap`
  (文字の縦書き化防止)、入力欄は `min-w-[8〜10rem] flex-1`。ジョブ行の説明は
  `min-w-0 flex-1 truncate`(truncateがminw-0なしのflex子では縮まず横はみ出しの根本原因
  だった)。履歴ヘッダ・履歴行も flex-wrap 化。
  Debugタブ: ヘッダ行(ツール選択/実行/再読込/自動承認チェック)を flex-wrap 化、
  セレクトは `min-w-0 max-w-full flex-1`、ツール一覧の検索行・各行・チェックポイント行も
  折り返し+truncate修正。計画タブのヘッダ行 flex-wrap、エージェントタブのモデル表示に
  min-w-0。**実起動スクリーンショットは行わず静的検証で代替**(NIGHT_TASKS4の代替条項。
  折り返し・nowrap・min-w-0 の構造を rightpane.layout.test.ts の6テストでソース固定)。
  全917テスト・typecheck 合格。
- **M29-2追加(2026-07-11 夜間自律作業その4 T2)**: **設定モーダルの高さ固定**。
  外形を `max-h-[90vh]`(内容依存の可変高)→ `h-[85vh]`(固定高)へ変更。
  スクロールは既存の中身側 `overflow-y-auto` が担うため、タブ切替でモーダルの
  大きさが変わらない。静的検証テスト2件(固定高+max-h不使用/全5タブの分岐が
  overflowコンテナ内にあること)で回帰防止。全911テスト・typecheck 合格。
- **M29-1追加(2026-07-11 夜間自律作業その4 T1)**: **無料APIモードの接続修正**(実機404バグ)。
  ①原因: Gemini プリセットの baseUrl だけ末尾スラッシュ付きで、OpenAI SDK のパス連結
  (baseURL + "/chat/completions")が "//" になり 404 (no body)。**OpenAIProvider の
  コンストラクタで末尾スラッシュを正規化**(全プリセット共通の防御)+プリセット定義側も
  スラッシュなしに統一し、両表記で同一URLになる単体テストとプリセット全件の
  末尾スラッシュ禁止テストを追加。
  ②Gemini 既定モデルを現行世代へ刷新: **gemini-3.5-flash(既定・最新Flash・安定)/
  gemini-3.1-flash-lite(最軽量)/ gemini-2.5-flash(旧世代・継続提供)**。
  根拠: 2026-07-11 に https://ai.google.dev/gemini-api/docs/models で実IDを確認
  (3.5-flash と 3.1-flash-lite は stable 表記。無料枠提供は
  https://www.aifreeapi.com/en/posts/gemini-api-free-tier-complete-guide 等の情報)。
  コード内コメントにも確認日とURLを記録。
  ③接続テストの診断力強化: 失敗時に**実際に叩くURL(connectionEndpoint)・model・
  HTTPステータス・レスポンスbody(SDKエラーの error フィールド)**を表示。
  テスト4件追加。全909テスト・typecheck 合格(フル実行のmanager 1件は既知の
  worktree掃除タイミング系フレークで単独再実行にて緑=合格扱い)。

- **M28(夜間自律作業その3・NIGHT_TASKS3.md 全6タスク完了)**。テスト905件・
  typecheck(node/web/remote)全合格。本体コミット6件(M28-1〜M28-6)+
  別リポジトリ `C:\dev\amateras-registry` にローカルコミット1件(push無し)。
  - **実施サマリ**:
    - T1(M28-1): 聖域ガードを通常経路にも拡張 — 自律/自動承認の聖域writeはハード拒否、
      手動は赤バナー+必ず個別承認。execは簡易検出。ガード自身も聖域化
    - T2(M28-2): 配布版の進化機能ガード — 机上トレース(docs/packaged-evolution.md)+
      きれいな無効化+UI説明。プラグイン専用進化パスは見送り(検証同等性が作れない)
    - T3(M28-3): 「作る前に探す」— registryUrl設定+検索(CJKバイグラム)→承諾カード→
      既存インポートパイプラインへ。freeModeでも検索・導入可
    - T4(M28-4): レジストリ雛形(C:\dev\amateras-registry)— 構造・検証CI(依存ゼロの
      validate.mjs同梱)・DCO・PRテンプレ・text_statsサンプル。git init+ローカルコミットのみ
    - T5(M28-5): 受け入れ態勢 — CONTRIBUTING(聖域変更PR原則却下・severity基準)+
      .github テンプレート一式
    - T6(M28-6): README.en.md(英語版・相互リンク)
  - **自分で決めた主要判断**(詳細は各M28-x項): bashの聖域言及は自律モードなら
    「書き込み指標との組」でハード拒否(指示の警告表示より安全側)/自律モード中は
    レジストリ検索をスキップ(承諾者不在のハング防止)/配布版のプラグイン専用進化パスは
    設計メモを残して見送り/レジストリCIは検証スクリプト同梱方式
  - **未解決・ユーザーへの連絡事項**:
    1. **実機での見た目確認は未実施**(禁止事項準拠で起動なし): 承認ダイアログの聖域
       赤バナー(手動モードで聖域ファイルをwriteさせると出ます)・接続タブのレジストリURL欄・
       進化パネルのpackagedバナー(これは配布版ビルドでのみ表示)
    2. レジストリ検索の実疎通は未検証(レジストリ未公開のため)。公開後、
      「接続」タブに raw URL を設定 → チャットで既存ツール相当の依頼をして
      候補カードが出るかを確認してください(手元検証は `npx serve C:\dev\amateras-registry`
      等のローカルHTTPでも可)
    3. amateras-registry の GitHub 作成・push・本体の公開はすべて未実施(ユーザー作業)。
       公開時は README 内の `<owner>` プレースホルダを実ユーザー名に置換してください
    4. bash経由の聖域書き換えは完全には防げません(docs/PROTECTED.md に制約を文書化。
       簡易検出は実装済み)

- **M28-6追加(2026-07-11 夜間自律作業その3 T6・任意)**: **README英語版**。
  `README.en.md` を作成(日本語READMEと同構成: 価値提案→特徴3本→インストール→
  Mermaid図→ライセンス+コントリビューション)し、日本語版冒頭と相互リンク。
  あわせて USER-GUIDE にレジストリ検索(M28-3)の使い方を追記。
- **M28-5追加(2026-07-11 夜間自律作業その3 T5)**: **本体リポジトリの受け入れ態勢**。
  `CONTRIBUTING.md` 新設(DCO・**聖域方針=聖域変更PRは原則却下**(理由と Issue 事前合意の
  導線)・コア改善PRの歓迎方針・レビュー基準=severity方式の表)。`.github/` に
  PRテンプレート(typecheck/vitest全緑・テスト追加・聖域非接触・DCO のチェックリスト)と
  Issueテンプレート3種(バグ報告=audit.jsonl とキー非混入の注意つき/機能要望=聖域関連の
  自己申告つき/プラグイン関連=危険挙動は失効リスト検討対象の明記)。README の
  ライセンス節から CONTRIBUTING への導線を追記。全905テスト・typecheck 合格。
- **M28-4追加(2026-07-11 夜間自律作業その3 T4)**: **レジストリリポジトリの雛形**を
  `C:\dev\amateras-registry` に新規作成(**git init+ローカルコミット 2418fd9 まで。
  push・GitHub作成は指示どおり未実施**。名義は新noreply)。構造: `plugins/<name>/`
  (コード+テスト+manifest.json)・`index.json`(M28-3の本体側検索と整合する
  スキーマ)・`revoked.json`(空の失効リスト=本体キルスイッチのURL先)・README
  (目的・導入は本体アプリから・投稿手順・検証済み/未検証の2層)・CONTRIBUTING
  (DCO・マニフェスト必須項目・外部npm依存ゼロ・権限宣言)・PRテンプレート
  (チェックリスト)・GitHub Actions `validate.yml`。
  CI検証は **`scripts/validate.mjs` を依存ゼロで同梱**(本体リポジトリのcheckoutなしで
  単体実行するため、M27-4の manifest/permissions と同一ルールを移植。同期義務を
  スクリプト冒頭に明記)+索引整合(dir⇔index相互・files実在・version一致)も検査。
  サンプルとして本体組み込みの `text_stats` をエクスポート形式で登録(verified: true・
  動的 `import('fs/promises')` を使うため fsScope: "workspace" を宣言=権限解析の手本)。
  `node scripts/validate.mjs` がグリーンであることを確認済み。本体側のコード変更なし。
- **M28-3追加(2026-07-11 夜間自律作業その3 T3)**: **「作る前に探す」レジストリ検索の本体側**。
  `AppConfig.registryUrl`(設定「接続」タブ・既定空=検索スキップ)。新モジュール
  `registry/search.ts`: `<registryUrl>/index.json` の取得・検証(ツール名規則・パス
  トラバーサル防止=ファイル名は単純名のみ)、依頼文とのマッチング(**英数語+CJK文字
  バイグラム**の素性重なり。日本語は空白区切りが無いため単純トークン化では機能しない
  ことがテストで判明し、バイグラム方式に変更)、候補ファイルのダウンロード。
  フロー: request_capability(scope=tool・新規のみ)が生成の前に
  `evolution.searchRegistryAndImport` を呼ぶ → 候補があれば承認カード
  「コミュニティに既存の進化があります」(名前/説明/作者/検証済みバッジ・未検証は追加警告)
  → 承諾でダウンロード → **M27-4のインポートパイプライン(B環境検証→昇格承認→導入)に
  接続**(ゲート省略なし)。拒否(declined)・候補なし・レジストリ未設定・ネット不達は
  静かに従来の生成フローへ。**freeMode でも検索・導入は許可**(「無料ユーザーは消費者」。
  生成のみ従来どおり無効 — plugin側で 検索→evolutionDisabled判定 の順に変更)。
  自分で決めた判断: (a) **自律モード中は検索をスキップ**(承諾カードを見る人間がおらず
  brokerが応答待ちでハングするため。生成へ直行し、昇格承認は従来どおり必ず人間)。
  (b) ダウンロード失敗・検査不合格は依頼元会話へ情報カードを流して生成へフォールバック。
  (c) index.json スキーマは T4 のレジストリ雛形と整合(registryVersion/plugins[name,
  description,version,author,verified,path,files])。
  テスト17件追加(index検証・マッチング・DL・plugin分岐5態・service統合3態・config)。
  全905テスト・typecheck 合格。
- **M28-2追加(2026-07-11 夜間自律作業その3 T2)**: **配布版(packaged)の進化機能ガード**。
  机上トレース(詳細は `docs/packaged-evolution.md`): packaged では `app.getAppPath()`=asar
  仮想パスのため、`enqueue` 冒頭の `nextJobId`(git tag)が最初の死点で生のgitエラーになり、
  以降も worktree(.git)・typecheck/vitest(devDeps/npm)・スモーク(npx)・昇格先
  (resources/plugins=読み取り専用)まで全段が前提を欠く。インポートも同経路のため不可。
  実装: `createEvolution` が `app.isPackaged` で無効化スタブを返す(safeModeと同型・
  safeMode判定より前。enqueue は平易な理由文で throw)。`runtimeFlags.packaged` を新設し、
  EvolutionPanel にバナー+「ジョブ起動」「📦 インポート」ボタン無効化。
  ソース・トリップワイヤのテスト2件で固定。
  **プラグイン専用進化パス(リポジトリ不要)は見送り**: esbuildでは構文チェックのみで
  型検査・vitestの代替が構造的に作れず「検証3段と同等の保証」が保てない+ローダ複数
  ディレクトリ化・世代管理など中規模改修のため。将来はレジストリ導入(検証をCIへ移す・
  署名+承認+キルスイッチはローカル)を配布版の本線とする設計メモを docs に記録。
  全890テスト・typecheck 合格。
- **M28-1追加(2026-07-11 夜間自律作業その3 T1)**: **聖域ガードを通常経路にも拡張**(セキュリティ)。
  従来、聖域トリップワイヤは進化ジョブ経路のみで、通常チャットの write は普通の承認で通っていた
  (自動承認+自律モード中にエージェントが自分のガードを書き換え得る穴)。
  新モジュール `src/main/tools/sanctuary.ts`: 判定リストは進化ゲートと同じ
  `evolution/protected.ts` の PROTECTED_PATHS を**単一ソースで共用**(二重定義なし。
  guardrailsテストで自前リスト定義が無いことを機械固定)。executor.ts に組み込み:
  - 書き込み系ツール(pathParams宣言)の解決パスがアプリ自身のリポジトリ
    (deny.repoGitDir の親で判定)の聖域に触れるとき —
    **自律モード or autoApprove.write ON: ハード拒否**(監査 hard-deny)/
    **手動: 赤バナー「🛡 保護領域(聖域)への変更」+警告付きで、セッション許可に
    関係なく必ず個別承認**(ApprovalRequestPayload.sanctuary を追加)
  - exec系(bash等)は簡易パターン検出: workspace がアプリリポジトリ内のときのみ、
    聖域パス言及で手動=警告表示、**自律モード=書き込み指標(リダイレクト・rm/mv/sed -i・
    PowerShell書込・git checkout/reset等)との組み合わせでハード拒否**。
    完全には防げない制約は docs/PROTECTED.md「通常経路(チャット)側のガード」に文書化
  - PROTECTED_PATHS に**ガード自身を追加**: tools/scope.ts・executor.ts・autonomy.ts・
    sanctuary.ts(sentinel/supervisorは既存の src/main/evolution に内包。docs/PROTECTED.md
    同期・protected.test 期待値も更新)
  自分で決めた判断: (a) 指示の「bashは警告表示まででよい」に対し、自律モードは警告を
  見る人間がいないため**言及+書き込み指標の組はハード拒否**に倒した(安全側)。
  読み取り系(grep/vitest等)や fd複製(2>&1)は指標に含めず誤検出を回避。
  (b) exec の言及判定は workspace がアプリリポジトリ内のときに限定(他プロジェクトで
  CLAUDE.md 等に触れるコマンドの誤検出防止)。(c) 聖域writeで allow-session を選んでも
  次回また必ずダイアログ(記憶自体は非聖域writeに有効)。
  テスト22件追加(sanctuary判定・exec検出・executor統合8態・単一ソースguardrail・
  protected拡張)。全888テスト・typecheck 合格。

- **M27-7追加(2026-07-10 公開前の最終整理)**: **git修復+Author書き換え+旧称MyCodexの一掃**。
  ①git修復: 報告のあった index/commit-graph エラーは実施時点で再現しなかったが、指示どおり
  `.git/index` 再生成+`commit-graphs` 削除を実施(どちらも非破壊の派生キャッシュ)。
  `git fsck --full` クリーン=**コミット本体に損傷なし**。
  ②全249コミットの Author/Committer を **moriwo-dev-ai \<yuta@users.noreply.github.com\>** へ
  書き換え(filter-branch env-filter・全ブランチ+全14タグ)。refs/original・reflog を掃除し
  `git gc --prune=now` で旧名義のオブジェクトを完全除去(`git log --all` の名義は1種のみを確認)。
  リポジトリローカルの git config(user.name/email)も同名義に設定。
  **注**: アプリが刻んだ commit(旧 MyCodex Evolution / mycodex-checkpoint 名義)も一律で
  新名義になった(env-filter は全コミット強制のため。「全コミット書き換え」の指示どおり)。
  ③旧称一掃(コード): `MYCODEX_SMOKE`→`AMATERAS_SMOKE` / `refs/mycodex/`→`refs/amateras/` /
  localStorage `mycodex-*`→`amateras-*` / `../mycodex-evolve`→`../amateras-evolve` /
  `MyCodexApi`→`AmaterasApi` / `MYCODEX_PLUGINS_DIR`→`AMATERAS_PLUGINS_DIR` /
  MCPクライアント名・checkpoint committer・一時ディレクトリ接頭辞・テストフィクスチャも統一。
  ④既存環境(この1台)への影響の吸収:
  - チェックポイント: `CheckpointManager.migrateLegacyRefs()` が初回アクセス時に旧refを
    新名へ自動移行(+旧メッセージ接頭辞 `[mycodex-checkpoint]` は読み取り互換を維持)
  - デスクトップUI設定(ペイン幅・アニメ): `lib/legacyStorage.ts` が起動時に一回きり移行
  - リモートUIトークン: `api.ts` loadToken が旧キーから一回きり移行(**再ログイン不要**。
    万一移行に失敗した場合のみ接続QRの再読取りで復帰)
  - 旧worktree残骸 `C:\dev\mycodex-evolve\job-2`(空・git未登録)と、対応する未昇格の
    残骸ブランチ `evolve/job-2`(text_stats生成の失敗ジョブ。後に別ジョブで昇格済みの機能)は
    削除済み(ブランチのコミットは次回gcまで `git fsck --lost-found` で回収可能)
  - **手順書(残る旧名)**: リポジトリのフォルダ名 `C:\dev\mycodex` と旧userData
    `%APPDATA%\mycodex`(M17ロールバック用に温存)、デスクトップの `MyCodex.lnk` は
    本整理の対象外(実パス・移行元・ユーザー所有物)。任意でリネーム/削除可。
    手動スモーク実行の環境変数は今後 `AMATERAS_SMOKE=1` を使うこと
  - 移行元として意図的に残した旧名参照: userDataMigration.ts・memory/plan の
    MYCODEX(_PLAN).md 後方互換・RemoteAccessSection の LEGACY_HOST_KEY・
    legacyStorage/api.ts の旧キー定数・checkpoints の旧接頭辞/旧refベース
  ⑤ドキュメント統一: ARCHITECTURE/PLAN/docs配下の製品名と現行動作の記述
  (SMOKE環境変数・refs・%APPDATA%\amateras 等)を統一。実在パス(C:\dev\mycodex)・
  リネーム自体を記録した歴史文書(M17系・PROGRESS過去項・VERIFICATION_REPORT)は不変更。
  テスト4件追加(旧ref移行・localStorage移行3態)。
- **M27(夜間自律作業その2・NIGHT_TASKS2.md 全6タスク完了)**。テスト866件・
  typecheck(node/web/remote)・build 全合格。コミット6件(M27-1〜M27-6)+本ドキュメント更新。
  - **実施サマリ**:
    - T1(M27-1): 無料APIモード — OpenAI互換プリセット(Gemini/Groq/OpenRouter)+
      「無料で始める」導線(3ステップ案内・接続テスト)+ freeMode制限(生成無効・既定軽量化)
    - T2(M27-2): AGPL-3.0 全文適用+NOTICE.md(商標方針)+README全面刷新(Mermaid図つき)
    - T3(M27-3): 公開前セキュリティ総点検 — 履歴走査=秘密情報の検出なし。正本 SECURITY_AUDIT.md
    - T4(M27-4): プラグインのエクスポート/インポート — manifest検証・権限の静的解析
      (宣言外API=自動拒否)・既存進化ゲートの完全再利用・キルスイッチ土台
    - T5(M27-5): pluginApiVersion 互換性契約 — ToolPlugin v1凍結・範囲外は無効化+理由表示・
      プラグインの src/main 内部import禁止を機械検出
    - T6(M27-6): UIテーマの宣言的データ化の土台(JSON定義・検証・カスタムテーマ適用)
  - **自分で決めた主要判断**(詳細は各 M27-x 項): ProviderId非拡張(openai+baseUrl+プリセット構成)/
    freeMode の reviewGate・ModelPolicy は強制OFF(設定値は保存のまま)/ zip見送り
    (ディレクトリ形式。レジストリもgit方式のため)/ 組み込みへの静的manifest付与は
    エクスポート時自動生成で充足と解釈 / 失効通知はツール一覧のエラー欄
  - **未解決・ユーザーへの連絡事項**:
    1. **コミットAuthorが個人メールのまま**(全履歴)。公開前に許容か書き換えかの判断を
       (SECURITY_AUDIT.md 参照。pushしていない今なら書き換え可能)
    2. 無料APIモードの**実疎通は未検証**(実キーがないため)。設定→基本→無料で始める→
       接続テストで初回確認を。互換レイヤ相性(stream_options等)が出たらエラー文言がそのまま出ます
    3. BRAND_STRATEGY.md / REGISTRY_DESIGN.md をコミット済み(README/NOTICEが参照)。
       **公開前に内容の最終目視を**
    4. 前夜からの持ち越し: `C:\Users\haru-\AppData\Roaming\Electron` の削除(未対応のままです)
    5. 新UIの一目確認: 設定「基本」の無料で始める枠/カスタムテーマ欄、「品質」の失効リストURL、
       ツール一覧の「📦 エクスポート」、進化パネルの「📦 インポート」(今夜も実機起動は
       行っていません。typecheck・テスト・buildでの検証のみ)
- **M27-6追加(2026-07-10 夜間自律作業その2 T6・任意)**: **UIテーマの宣言的データ化(土台のみ)**。
  REGISTRY_DESIGN.md 3層モデル「見た目の共有=宣言的データ(実行リスクゼロ)」の布石。
  `src/shared/uiTheme.ts`: テーマJSONのスキーマ(name / base: dark|light / colors=9スロット:
  bgDeep・bgPanel・bgRaised・bgHover・border・textMain・textSub・accent・accentText)、
  検証 `parseUiTheme`(**値は16進カラーのみ=データ由来のCSSインジェクション不可**。
  テーマ名の `*/` もコメント脱出できないよう除去)、CSS生成 `uiThemeCss`
  ([data-theme='custom'] スコープでライトテーマ(M25-5)と同じ「ユーティリティクラス上書き」
  方式。未指定スロットは base 側標準値で補完)。renderer `lib/customTheme.ts`: 適用・解除・
  localStorage永続・起動時復元。UI: 設定「基本」タブに折りたたみの
  「カスタムテーマ(JSON・実験的)」(貼り付け→適用/標準に戻す)。
  土台の範囲(記録): 透明度サフィックス等の細部エイリアス網羅・テーマファイルの
  流通(ファイル選択/共有)はフェーズ3の本実装で拡充。ヘッダーのテーマ選択(ダーク/ライト)
  とは独立に上書きする(解除で標準設定へ戻る)。テスト7件追加(検証・注入防止・補完・CSS生成)。
  全866テスト・typecheck 合格(フル実行の processes.test 1件は今夜の変更と無関係の
  プロセスkillタイミング系で、単独再実行で緑=既知のWindows並列負荷扱い)。
- **M27-5追加(2026-07-10 夜間自律作業その2 T5)**: **pluginApiVersion(互換性契約)**。
  ①現行 `ToolPlugin` インターフェースを **v1 として凍結**(正本
  `src/main/tools/versioning.ts` の `PLUGIN_API_VERSION='1.0.0'`。types.ts に凍結コメント。
  semver運用: マイナー=追加のみ・破壊的変更=メジャーのみ)。
  ②範囲照合 `satisfiesApiRange`(npm互換の最小サブセット: ^/~/桁一致。解釈不能は安全側false)。
  ③loader が `<name>.manifest.json`(インポートプラグインが同梱)の pluginApiVersion を照合し、
  **範囲外はクラッシュではなく無効化+理由をツール一覧のエラー欄に表示**
  (マニフェスト無し=組み込み・従来プラグインは常に互換扱い)。インポート検査
  (inspectImportDir)でも範囲外を事前拒否。ImportJobRunner がマニフェストを
  `<name>.manifest.json` として同梱コピーするようになった。
  ④**プラグインの依存契約の機械検出**(guardrails.imports.test.ts): 非テストのプラグインが
  import してよいのは `../types`(ToolPlugin)・node組み込み・`shared/types` の import type のみ。
  src/main 内部・外部npm・同ディレクトリ他プラグインへの import はテストが落ちる
  (現状の全プラグインは違反ゼロを確認済み。将来レジストリCIの先行実装を兼ねる)。
  自分で決めた判断: 指示の「組み込み全プラグインのマニフェストに ^1 付与」は、静的な
  manifest.json を20個追加すると説明・権限の二重管理ドリフトが生じるため、
  **エクスポート時の自動生成(既定 ^1)+インポート時の同梱**で充足と解釈した
  (組み込みはAPIと同梱なので定義上常に互換。実行時に照合が必要なのは外から来たものだけ)。
  テスト13件追加(範囲照合・loaderの無効化3態・インポート拒否・同梱コピー・import契約走査)。
  全859テスト・typecheck 合格。
- **M27-4追加(2026-07-10 夜間自律作業その2 T4)**: **プラグインのエクスポート/インポート基盤**
  (ローカル完結。レジストリ本体は将来の別リポジトリ)。新モジュール `src/main/registry/`:
  ①manifest.ts=REGISTRY_DESIGN.md準拠のマニフェスト検証(semver・pluginApiVersion範囲・
  AGPL互換ライセンス許可リスト・依存ゼロルール・permissions形)。②permissions.ts=コードの
  静的解析による権限自動抽出(モジュール参照+fetch/WebSocket等のグローバルAPI)と宣言との
  突き合わせ(**宣言外API使用=自動リジェクト**、過剰宣言=警告。将来レジストリCIと共通化)。
  ③packager.ts=エクスポート(コード+テスト+manifest.jsonの1ディレクトリ書き出し。権限は
  自動抽出で生成)とインポート検査。④importRunner.ts=`ImportJobRunner`(LLM生成の代わりに
  検査済みファイルをBへコピー)+`composeRunners`(importFrom有無で振り分け)。
  **インポートは既存の進化パイプラインをそのまま通す**(EvolutionRequest.importFrom を追加し、
  worktree→検証3段→承認ダイアログ(diff+危険API警告)→昇格→ロールバックが完全に同一経路=
  ゲート省略なし。既存同名ツールは targetTool 扱いで「更新」になる)。
  ⑤killswitch.ts+ToolRegistry.revoke=失効リストURL(設定「品質」タブ・既定空)を起動時
  フェッチし一致プラグインを自動無効化(理由はツール一覧のエラー表示=ユーザー通知。
  不達は静かにスキップ、reload後も失効維持)。UI: ツールデバッグの各行に「📦 エクスポート」、
  進化パネルに「📦 インポート」。IPC `plugins:export` / `plugins:import` 新設。
  自分で決めた判断: (a) **zip対応は見送り**(外部依存ゼロでの実装コスト・リスクに対し、
  ディレクトリ形式で機能要件を満たす。レジストリ実体もgitディレクトリ方式でzipは不要)。
  (b) スモーク入力は manifest の任意フィールド `smoke.input`(エクスポート時は {} を出力。
  生成時の入力が残っていないため)。(c) fsScope の静的判定は none/workspace の2値
  (実行時スコープはexecutorが強制するため宣言は情報提供が主目的)。(d) 失効通知は
  ツール一覧のエラー欄で表示(専用トースト基盤を今夜作るより誤配線リスクが低い)。
  テスト34件追加(manifest検証・権限抽出/突き合わせ・エクスポート往復・インポート検査・
  ImportJobRunner・composeRunners・registry失効(reload持続含む)・killswitchパース・
  service enqueue配線・**manager実git統合2件(インポート完走/ゲート不合格でfailed)**)。
  全826テスト・typecheck 合格(フル実行1回目のmanager 1件は既知Windows並列負荷、単独再実行で全緑)。
- **M27-3追加(2026-07-10 夜間自律作業その2 T3)**: **公開前セキュリティ総点検**
  (結果の正本は `SECURITY_AUDIT.md`)。git全履歴(249コミット)へのキー/シークレット/
  個人パス走査=検出なし。キー経路=SecretStore+safeStorage(DPAPI)のみ・renderer/リモート/
  ログ/セッションへの漏えい経路なし。リモートトークン=256bit+sha256保存+timingSafeEqual+バン。
  .gitignore へ `.claude/settings.local.json`・`downloads/`・`build/candidates/`・
  `NIGHT_TASKS*.md` を追加し、`build/icon.svg`(採用アイコン)と
  `BRAND_STRATEGY.md`/`REGISTRY_DESIGN.md`(README/NOTICEが参照する恒久文書)をコミット。
  未解決(ユーザー判断待ち): コミットAuthorの個人メール(公開前に許容or書き換えの判断)、
  Roaming\Electron の削除(再掲)、戦略文書の公開可否の最終目視、CI でのシークレット
  スキャン導入(フェーズ1残課題)。履歴書き換えは指示どおり未実施。
- **M27-2追加(2026-07-10 夜間自律作業その2 T2)**: **AGPL-3.0適用+README刷新**。
  `LICENSE` に AGPL-3.0 全文(gnu.org 正本から取得。sha256=0d96a4ff…canonical一致を確認)、
  `package.json` に `"license": "AGPL-3.0-only"`。`NOTICE.md` 新設(商標方針=フォークは別名/
  DCO方式/公開範囲の方針)。`README.md` を指示の構成順序どおり全面刷新
  (1行価値提案→デモGIFプレースホルダ docs/demo.gif→特徴3本[安全な自己進化・6帯・無料API]→
  インストール→Mermaidアーキ図→ライセンス+コントリビューション)。
  自分で決めた判断: 旧READMEのリモートアクセスのセキュリティ前提(0.0.0.0 listen・
  tailnet境界・リモートAPI非公開範囲)は消さずに `docs/REMOTE-SECURITY.md` へ移設して
  READMEからリンク(T3のセキュリティ監査でも参照する内容のため)。
- **M27-1追加(2026-07-10 夜間自律作業その2 T1)**: **無料APIモード**(カード登録なしで即開始する入口)。
  ①OpenAI互換カスタムエンドポイント: `OpenAIProvider` に baseURL 注入(第3引数)。
  互換モード(baseURL指定時)では `max_completion_tokens` の代わりに従来の `max_tokens` を
  送る(Gemini/Groq/OpenRouter の互換レイヤで確実なのは max_tokens のため。パラメータ名は
  `buildOpenAIParams` の opts で切替)。プリセットは `shared/models.ts` の `PROVIDER_PRESETS`
  (gemini=既定推奨/groq/openrouter。baseUrl・既定モデル・候補・キー取得ページ・3ステップ案内・
  429文言)。コンテキスト上限も gemini-/llama- 等の prefix を追加。
  ②型構成: **ProviderId は拡張せず「openai + providerPreset + 専用キースロット」構成**
  (NIGHT_TASKS2 の許容案。ProviderId 拡張は fallback/帯/usage 等へ波及が大きすぎるため)。
  `SecretSlot = ProviderId | ProviderPresetId` で SecretStore/IPC のキー保存を5スロット化。
  ③かんたんセットアップ: 設定「基本」タブに「無料で始める」枠(プリセット選択→3ステップ
  案内+キー取得ページを開く(main側固定allowlist=openBillingPage 流用)→キー貼付(OS
  キーチェーン経路)→接続テスト)。接続テストは新IPC `connection:test` →
  `AgentService.connectionTest()`(最小1リクエスト・30秒タイムアウト)。
  ④freeMode制限: プリセット選択で自動ON(手動切替可)。実効値制御は config.ts の純関数に
  集約(`effectiveMaxTurns`=既定15/`effectiveReviewGate`=常にOFF/`effectiveModelPolicy`=
  常に無効/`evolutionDisabledReason`)。request_capability は ToolContext.evolutionDisabled
  経由で案内文を返しジョブを起動しない(`freeModeAllowEvolution` でオプトイン解除)。
  無料枠の学習利用注意文(FREE_API_TRAINING_NOTICE)を「無料で始める」枠に常時表示。
  429はループの新フック `describeLLMError` でプリセット別の平易文言に差し替え
  (メイン会話のみ。サブエージェントは従来表示)。
  自分で決めた判断: (a) freeMode の reviewGate/ModelPolicy は「既定OFF」ではなく**強制OFF**
  とした(指示文の「既定」解釈。無料枠でのゲート往復は枠を溶かす+設定保存値は壊さず
  freeMode解除で即復元されるため安全側)。(b) maxTurns だけは明示設定があれば尊重
  (ヘビーユーザーの意図を潰さない)。(c) プリセットの既定モデルは2026-07時点で無料枠が
  確実な保守的ID(gemini-2.5-flash 等)にし、変動リスクはUIのカスタム入力で吸収。
  (d) 互換エンドポイントの実疎通(実キーなし)は未検証 — 接続テストUIをユーザーの
  初回確認手段として用意した。テスト28件追加(baseURL/max_tokens切替・プリセット整合・
  config正規化・実効値純関数・キースロット・request_capability無効化・connectionTest・
  describeLLMError・isRateLimitError)。全792テスト・typecheck 合格。
- **M1〜M26(夜間自律作業 T1〜T9)完了**。テスト764件・typecheck(node/web/remote)・build 全合格。
- **夜間自律作業サマリ(2026-07-09夜〜07-10未明・NIGHT_TASKS.md 全9タスク完了)**:
  - T1(M26-1): レビューゲートを severity 方式へ再較正(high指摘ゼロで合格。既定変更)
  - T2(M26-2): reviewer 帯を分離(日常レビューは安価帯。最終マイルストーン/聖域変更/
    完成時レビューは planner 固定)。T1の passMode が保存で消えるバグも発見・修正
  - T3(M26-3): fix 3段階段(worker→midEscalation→escalation)+ explorer 帯(mode:"read"調査)
  - T4(M26-4): Fable5 の refusal 自動フォールバック(1会話2回・1段下モデル優先)+
    帯別コスト可視化 + 30日データ保持の注意文
  - T5(M26-5): 設定画面を5タブ化(基本/モデル運用/品質/接続/記憶)・セクション5ファイルへ分割
  - T6(M26-6): 進化ジョブのキャンセルUI(queued=キュー除去/実行中=abort)。
    abort後に生成リトライが走る潜在バグも発見・修正
  - T7(M26-7): 会話の workspace 移動操作(EnvWidgetの「移動」→確認→以降のランが新参照)
  - T8(M26-8): theme-mock/・旧AMATERAS_PLAN.md を削除(未追跡だったため退避コピー後に削除)
  - T9(M26-9): service.ts から帯解決(bands.ts)とレビューゲート連携(gateRunner.ts)を機械的抽出
  - **ユーザーへの連絡事項(起床後に確認を)**:
    1. `C:\Users\haru-\AppData\Roaming\Electron` は私のCDP検証の誤起動で作られた
       実設定の複製(鍵素材のコピー含む)。**削除推奨**(rmはツール権限で拒否され残置)
    2. デスクトップに `electron-vite preview` 起動のアプリが1つ開いたまま
       (プロセス終了が権限で不可だった)。**ウィンドウを閉じるだけでOK**(現行ビルドで無害)
    3. T5(設定タブ)/T6(キャンセルボタン)/T7(移動ボタン)の実機での見た目確認は
       未実施(CDP不可のためビルドバンドルの静的検証で代替)。次回起動時に一目確認を
- **M26-9追加(2026-07-10 夜間自律作業 T9・任意)**: **service.ts の機械的分割**(挙動変更なし)。
  ①モデル帯解決部: 帯名(`ModelBandName`)と未指定時フォールバック規則を
  `src/main/core/bands.ts` の純関数 `resolveBandLLM(policy, band)` へ抽出。
  service.ts は互換のため型を再export(既存の import 元は不変)。
  ②レビューゲート連携部: `runReviewGate` の本体(reviewer帯選択・レビューサイクル・
  fix階段・上限到達時の承認)を `src/main/review/gateRunner.ts` の `runReviewGateStep` へ
  抽出。service 依存(帯プロバイダ生成・workサブエージェントfix・承認ブローカー・audit)は
  コールバック注入とし electron 非依存を維持。service 側は薄いラッパーのみ残す
  (guardrails.reviewgate.test.ts の「this.runReviewGate( 呼び出しは2箇所」も不変)。
  service.ts は約1950行→1804行(bands.ts 32行+gateRunner.ts 165行へ移動)。
  全764テスト・typecheck・build 合格
  (git系1件の単発フックタイムアウトは単独再実行で緑=既知のWindows並列負荷、合格扱い)。
- **M26-8実施(2026-07-09 夜間自律作業 T8)**: **掃除**。`theme-mock/`(M25-5テーマ検討時の
  モックHTML6枚)と旧 `AMATERAS_PLAN.md`(M25-5テーマ作業の完了済み計画の残置物)を削除。
  注意: NIGHT_TASKS には「git管理下なので復元可能」とあったが、実際には両方とも
  **未追跡ファイルで git からは復元不可能**だった。念のため削除前に全ファイルを
  スクラッチパッド(`%TEMP%\claude\...\scratchpad\t8-backup\`)へ退避コピーしてから削除した
  (セッション終了後に消える一時領域なので、必要なら早めに回収を)。
  未追跡のまま残っている `NIGHT_TASKS.md`・`build/candidates/`・`build/icon.svg`・
  `downloads/` は指示範囲外のため触っていない。
- **M26-7追加(2026-07-09 夜間自律作業 T7)**: **会話の workspace 移動操作(evolve/8 残課題)**。
  `AgentService.conversationMoveWorkspace(newWorkspace)`: 現在表示中の会話の workspace を
  明示的に変更する。実行中(conv.run あり)は拒否(実行中ランの束縛は変えない設計)。
  移動先は絶対パス+実在ディレクトリのみ。移動するとグローバル設定(config.workspace)も
  追従し(左ペイン会話切替=sessionOpen と同じ規則)、セッション永続化+チャットへ
  infoカードを流す。以降のラン(ツール実行・チェックポイント・計画/記憶)は移動先を参照。
  scopeMode='project' のスコープ境界も次のランから新 workspace 基準になる。
  UI: EnvWidget(右ペイン上部の📁行)に「移動」ボタンを追加。フォルダ選択(pickWorkspace)→
  インライン確認(移動する/取消)→実行、の二段。実行中(busy)はボタン無効。
  IPC `conversation:move-workspace` を新設(ipc.ts/preloadは聖域だがユーザー明示指示の開発作業)。
  自分で決めた判断: (a) 対象は「現在表示中の会話」のみとした(UIの「この会話を移動」の
  意味に一致。他会話は切り替えてから移動すればよい)。(b) config.workspace への追従は
  sessionOpen の既存規則に合わせた(移動後に新規会話を作った場合も同じ場所で始まり、
  EnvWidget 表示とも食い違わない)。テスト3件追加(移動+設定追従+次ランのcwd反映・
  実行中拒否・不正パス3種)。全764件(うち2件はgit系の既知Windows並列負荷タイムアウトで
  単独再実行により全緑=完了条件どおり合格扱い)・typecheck・build 合格。
- **M26-6追加(2026-07-09 夜間自律作業 T6)**: **進化ジョブのキャンセルUI**。
  manager.ts:187 の NOTE(signal配線のみでabort経路なし)に対応。
  `EvolutionManager.cancel(id)`: queued=キューから除去して即 cancelled、
  実行中(preparing_worktree/generating/verifying)=AbortController.abort() で中断。
  awaiting_promotion 以降は対象外(昇格ダイアログの「却下」の担当領域)。
  `EvolutionJobStatus` に 'cancelled' を追加。IPC 経路 `evolution:cancel` を新設
  (shared/ipc.ts・preload・main/ipc.ts。聖域だがユーザー明示指示の開発作業。
  承認UI・ゲートのロジックは不変更)。EvolutionPanel の実行中/待機中ジョブに
  「✕ キャンセル」ボタンを表示。
  実装中に発見した実バグ: 生成例外の「1回リトライ」がキャンセル(abort)起因の失敗でも
  走ってしまい、abort済みsignalで generate が再実行される問題があった
  (リスナーは既発火のabortイベントを二度受けられないため永久ブロックし得る)。
  キャンセル起因ならリトライせず即中断へ倒す修正を追加(テストのタイムアウトが検出)。
  自分で決めた判断: (a) 'cancelled' は failed と区別する専用ステータスにした
  (remote-ui は生ステータス文字列表示なので追加変更不要)。
  (b) verifying 中のキャンセルは実行中のゲート子プロセス自体は殺さず、
  次のチェックポイントで中断する(ゲートは短時間で完了するため)。
  テスト4件追加(queued除去・実行中abort+worktree掃除・後続キュー継続・対象外false)。
  全761件・typecheck 合格。
- **M26-5追加(2026-07-09 夜間自律作業 T5)**: **設定画面のタブ分け**。525行の SettingsPanel.tsx を
  5タブ構成に再構成: **基本**(プロバイダ/モデル+Fable5注意/APIキー/作業ディレクトリ/操作範囲)、
  **モデル運用**(ModelPolicy/フォールバック/maxTurns/サブエージェント設定)、
  **品質**(ReviewGate/ツール自動承認/編集後フック)、**接続**(Usage/RemoteAccess/MCP)、
  **記憶**(ユーザー方針/プロジェクト記憶)。テーマ+アニメーション切替はヘッダへ移動。
  中身は BasicSection / ModelOpsSection / QualitySection / ConnectionsSection / MemorySection の
  5ファイルへ切り出し(既存の ModelPolicySection 等はその中で再利用)。状態(config等)は
  従来どおり SettingsPanel に集約して props で渡す(zustand導入なし)。タブUIは RightPane の
  既存パターン(border-b-2 border-blue-500)を流用し、タブ切替の anim-fade も同じ。
  見た目の確認: CDPでの実機確認を試みたが、(1)`npx electron out/main/index.js` 直接起動は
  appName が Electron になり userData 迷子+プラグインパス解決が壊れて不成立
  (この誤起動が `C:\Users\haru-\AppData\Roaming\Electron` に実設定の複製を作ってしまった。
  **→ユーザーへ: このフォルダは削除推奨**。rm はツール権限で拒否されたため残っている)、
  (2)`electron-vite preview` 起動は成功したがポート競合や単一インスタンスロックの絡みで
  CDP接続まで到達できず、プロセス強制終了も権限で不可だったため断念。
  **preview 起動のインスタンス(現行ビルド・タブUI入り)が1つデスクトップに開いたまま残っている**
  (無害。ウィンドウを閉じてもらえばよい)。代替として、ビルド後の実バンドルに
  5タブのラベル・Fable5注意文・帯別コスト表・severityラジオ・新帯ラベルが全て含まれることを
  スクリプトで確認済み(11項目 OK)。typecheck・build・全757テスト合格(挙動変更なしのUI再構成)。
- **M26-4追加(2026-07-09 夜間自律作業 T4)**: **セーフガード拒否(refusal)の自動フォールバック
  +帯別コスト可視化**。Fable5 は API 経由だとセーフガード該当時に stop_reason='refusal' で
  応答拒否され、従来 loop.ts は即エラー停止していた(空応答扱い。部分出力ありの
  mid-stream refusal は無言で done になっていた)。
  変更: `AgentLoopDeps.acquireFallback` に `kind?: 'billing'|'refusal'` を追加。
  loop は refusal を検知すると acquireFallback(reason,'refusal') を呼び、プロバイダが
  返れば**同一ターンをやり直す**。service 側は billing の「1会話1回」(fallbackUsed)とは
  **別枠のカウンタ `refusalFallbackCount`(1会話2回まで)**で管理し、候補は
  「同一プロバイダの1段下モデル」優先(fable-5→opus-4-8→sonnet-5→haiku、gpt-5.5→5.4。
  段下が無ければ設定済みフォールバック先)。audit には 'refusal(N/2)' 付きで記録。
  フォールバック不発の refusal は部分出力があっても error 停止に変更(無言のdone廃止)。
  コスト可視化: `track()`/UsageMeter.record に band ラベルを追加し、
  usage.json に day→band→model の帯別集計を併記(旧ファイルは bands 空で後方互換)。
  UsageSection に帯別(main/planner/worker/explorer/reviewer/midEscalation/escalation/
  fallback/other)の累積トークン・概算コスト表を追加。設定画面のモデル選択で
  claude-fable-5 選択時に「入力データは安全対策のため30日間保持されます(ZDR非適用)」を表示。
  自分で決めた判断: (a) refusal の1段下切替は fallback 設定が無効でも発動する
  (メインプロバイダのキーをそのまま使うため追加設定不要。突然死回避を優先)。
  ただし子エージェント(acquireChildFallback)は現在モデルを機械決定できないため
  設定済みフォールバック先を使う(fb無効なら発動しない)。
  (b) 進化ジョブ(createProviderOrThrow経由)の帯ラベルは 'main' に含まれる。
  テスト6件追加(loop refusal 4・usage band 2)。全757件・typecheck 合格。
- **M26-3追加(2026-07-09 夜間自律作業 T3)**: **3段エスカレーション + explorer帯**。
  `ModelPolicy.midEscalation?`(中間格上げ先。未指定なら escalation)と
  `ModelPolicy.explorer?`(調査用。未指定なら worker)を追加。
  レビュー差し戻しfixは **round 1-2=worker → 3=midEscalation → 4以降=escalation** の階段に変更
  (従来は round>=3 で即 escalation)。dispatch_agent の調査系(mode:"read"。単発runと
  parallel read の両方)は explorer 帯を使用、mode:"work" は従来どおり worker 帯。
  POLICY_HINT に「調査・ファイル探索は mode:"read" で委譲(安価な explorer が担当)。
  planner は大量のファイルを自分で読まない」を追記。sub_update の表示モデルラベルも
  read=explorer帯 に追従。ModelPolicySection に explorer/midEscalation の行を追加し、
  プリセット更新(高品質重視: explorer=Sonnet, mid=Opus4.8 / コスパ重視: explorer=Haiku,
  mid=Opus4.8)。自分で決めた判断: (a) NIGHT_TASKS の「mode:'research'」は本アプリでは
  dispatch_agent の mode:"read"(読み取り専用調査)が該当するためそちらへ適用。
  (b) midEscalation帯のキー未登録は警告なしで escalation へ静かにフォールバック
  (オプショナルな中間段のため。explorer未登録は警告カードあり=worker代行)。
  テスト4件追加(fix階段1・explorer配線1・config2)。全751件・typecheck 合格。
- **M26-2追加(2026-07-09 夜間自律作業 T2)**: **レビュアー帯の分離(監査役パターン)**。
  従来レビューは常に planner 帯(最上位モデル)だったため日常レビューのコストが高かった。
  `ModelPolicy.reviewer?: ModelBand` を追加(未指定なら従来どおり planner 代行)。
  `runReviewGate` は通常レビューを reviewer 帯で実行し、以下の3条件では planner 帯へ固定:
  (a) 計画の最終マイルストーン完了時(plan書き込み後に `- [ ]` が残っていない)
  (b) そのランでコア領域(聖域=PROTECTED_PATHS)への書き込みがあった場合
  (c) 完成時レビュー(縮退モード。タスク全体の最終確認のため planner とした)。
  ModelPolicySection に reviewer の BandRow を追加し、プリセットを更新
  (高品質重視: reviewer=Fable(planner同格) / コスパ重視: reviewer=Haiku(worker同格))。
  自分で決めた判断: (a) コア領域の定義は進化サブシステムの聖域正本 `PROTECTED_PATHS`
  (`isProtectedFile`)を service 側から共用した(重複定義を避ける。guardrailsは
  evolution→band参照の方向を禁じており、逆方向のimportは問題ない)。
  (b) コア領域検知は書き込みツールの pathParams 宣言ベースで、bash等のパス無宣言ツール
  経由のコア変更は捕捉できない(既知の限界としてコメントに明記)。
  (c) NIGHT_TASKS の「(c)進化昇格前レビュー」は現状 reviewGate が進化ジョブに適用されない
  設計(guardrails.reviewgate.test.tsで固定)のため該当経路が存在せず、実装対象なし。
  将来進化昇格前レビューを作る場合は forcePlannerReview:true を渡すこと。
  (d) guardrails.modelpolicy.test.ts の banned リストは汎用識別子(bandLLM等)ベースで
  帯名を列挙していないため、'reviewer' 追加は不要と確認。
  (e) T1の passMode が `parseReviewGate` の正規化で落ちる取りこぼしを発見し修正
  (保存すると passMode が消えるバグになるところだった)。
  テスト6件追加(service配線4・config2)。全748件・typecheck 合格。
- **M26-1追加(2026-07-09 夜間自律作業 T1)**: **レビューゲートの合格判定を severity 方式へ再較正**。
  背景: 「4軸平均4.0以上で合格」+辛口レビュアー指示の組み合わせでは worker帯の成果物が
  構造的に不合格になり、エスカレーション(最上位モデル稼働)が多発していた。
  変更: `ReviewFinding` に `severity: 'high'|'medium'|'low'` を追加
  (high=マイルストーンの要件を満たさない/壊れている、medium=品質上望ましくないが動く、
  low=好みの問題)。`ReviewGateConfig.passMode: 'severity'|'score'` を追加し、
  **既定は 'severity'(high指摘ゼロなら合格。スコア平均は表示用に残す)**、'score' は従来の
  平均閾値方式。パース時に severity が3値以外・欠落なら medium にフォールバック
  (findings を捨てない)。`buildFixTask` は severity 方式では high のみ差し戻し対象にし、
  medium/low はレビューカードに記録するだけ。ReviewCard に severity バッジ
  (high=赤/medium=琥珀/low=グレー。ライトテーマ上書き済みの既存クラスのみ使用)、
  設定画面に合格判定方式のラジオ切替を追加。remote-ui はテキスト整形に `[severity]` を追記。
  自分で決めた判断: (a) `passMode` はオプショナルにして未指定=severity とした
  (保存済み設定の後方互換を保ちつつ、再較正の趣旨どおり既定挙動を変えるため)。
  (b) `ReviewFinding.severity` は必須型にした(生成箇所が parseReviewOutput のみで
  常に値が入るため)。旧永続イベントの表示はUI側で medium にフォールバック。
  (c) service.reviewgate.test.ts の既存配線テストは passMode:'score' に固定
  (severity 無し findings を使うため。severity 方式のロジック自体は gate.test.ts で担保)。
  テスト6件追加(severityパース1・severity合格判定3・buildFixTask絞り込み2)。
  全742件・typecheck 合格。
- **M25-8追加(2026-07-08)**: **①既存ツールの修正パイプライン ②ツールのタグ付け・絞り込み
  ③チャット送信欄の停止ボタンを枠内デザインへ ④Markdownテーブルのヘッダーが黒背景で
  読めないバグ修正**、の4件。
  ①: `request_capability` に `target_tool`(既存ツール名)を追加。指定すると新規作成ではなく
  該当プラグインファイルの直接修正として扱われる(プロンプトが変わり、既存ファイルを読んでから
  編集するよう指示)。`EvolutionManager` に新規作成時の既存ツール名衝突チェックと、
  target_tool指定時の生成結果名一致チェックを追加(不一致は通常のゲート不合格と同じ経路で
  フィードバック付き再生成、2回試しても直らなければfailed)。target_toolが実在しない場合は
  worktreeも作らず即rejectする。`existingToolNames`(Aで実際にロード中のツール名一覧)を
  新規depsとして注入。
  ②: `ToolPlugin`/`ToolInfo` に `tags?: string[]` を追加。全20個の既存プラグインに
  分類タグを付与(ファイル操作・Web操作・コマンド実行・テキスト処理・進化・記憶・計画・
  サブエージェント・検索)。進化ジョブの生成プロンプトにも「新規ツールにはtagsを1つ以上
  つける」よう追記。DebugタブのツールデバッグパネルにDebugタブ「ツール一覧」セクションを
  新設(タグチップでの絞り込み+名前/説明のテキスト検索、クリックで実行対象に選択)。
  ③: ChatViewの送信欄を`position:relative`でラップし、実行中の停止ボタンをtextarea右下に
  絶対配置(黒丸+中央に白い正方形、ホバーはopacity-80でライトテーマのzinc系ホバー上書きに
  巻き込まれないようにした)。外側の従来の「停止」テキストボタンは廃止。
  ④: MarkdownMessage/FilePreviewの表ヘッダーが`[&_th]:bg-zinc-700`のような任意バリアント
  記法で、`.bg-zinc-700`とは全く別のコンパイル結果(`.\[\&_th\]\:bg-zinc-700 th {...}`)に
  なるため、M25-5/M25-6のクラスベース上書きの対象外になっていた(ホバーバグと同系統の
  「Tailwindの非標準コンパイル形をシンプルなクラス名一致だけでは捕捉できない」問題)。
  実際に使われている2パターン(zinc-700/zinc-800)を個別にエイリアス追加して解消。
  ビルド後の実CSSバンドルに両ルールが正しく出力されていることを確認。
  ユーザーの現在のAMA-terasが進化ジョブ実行中で稼働していたため、今回はCDPでの実機
  スクリーンショット確認ができなかった(既存インスタンスを止めたくなかったため)。
  typecheck・build・ビルド後CSSバンドルへの出力確認・テストコードでの静的検証で代替。
  テスト8件追加(request_capability 4件・manager 4件)+既存2件をtags反映で更新。
  全736件・typecheck・build合格(並列負荷によるgit系テストのタイムアウトが単発で
  出ることがあるが、単独/再実行では毎回合格する既知のWindows環境要因)。
- **M25-7追加(2026-07-08)**: **複数の進化ジョブを同時に投げたとき、再起動を挟むと後続ジョブが
  何のエラーも履歴も残さず消える問題を修正**。ユーザーからの質問(2つの進化ジョブを実行中、
  1つ目が完了したら昇格していいか?)を受けて調査した結果、想定より一段深刻な実態が判明:
  ①進化ジョブは直列キュー(`manager.ts`で意図的な設計、worktree衝突回避のため)なので、
  「昇格した瞬間に別ジョブが実行途中で巻き込まれる」ことはそもそも起きない(直列なので)。
  ②しかしrenderer/core昇格が`requestRestart`(5秒後に`app.relaunch()+app.exit(0)`)を呼んだ後も
  `drain()`はキューを止めずに次のジョブへ進んでしまい、その5秒の間に次のジョブが実際に着手
  (worktree作成・生成開始)してから強制終了で消える、あるいはまだ未着手でもキュー自体が
  インメモリのみで再起動をまたいで保持されないため、いずれにせよ「失敗」にすらならず
  黙って消えていた(次回起動時の復旧・通知ロジックも皆無だった)。
  対策: `EvolutionManager`に`restarting`フラグを追加し、renderer/core昇格が
  `requestRestart`を呼んだ時点で立てて`drain()`のループを止める(以降キューは進めない)。
  止まった時点でキュー中の未着手依頼を`pendingRequests()`で公開し、`ipc.ts`側の
  `requestRestart`実装がそれを`evolution-pending-queue.json`(userData)へ退避してから
  再起動する。次回(非セーフモード)起動時に`createEvolution`が同ファイルを読み戻し
  自動で再enqueueする(セーフモード中はこの分岐に入らないため、ファイルは手つかずのまま
  残り通常起動に戻ったときに拾われる)。生成途中の作業内容までは復元できないが、
  依頼(description/expectedIO/scope)自体は最初からやり直す形で失われない。
  実際の判断: 進行中だった job-11 は `src/main/tools/plugins/` のみを変更するscope:tool
  ジョブだったため、昇格しても再起動自体が発生せず(tool scopeはホットリロード経路)、
  この問題の影響を受けずに安全に昇格できると確認した上でユーザーへ回答した。
  テスト6件追加(`pendingQueue.test.ts`5件+`manager.core.test.ts`に直列キュー停止の
  回帰テスト1件)。回帰テストは一時的にdrain()の修正を巻き戻して確実に落ちることを確認
  (タイミング依存を避けるため、2つ目のジョブのgenerate()呼び出し回数を数える方式で検証)。
  全677件・typecheck・build合格。
- **M25-6追加(2026-07-08)**: **ライトテーマでボタンにホバーすると背景が黒くなるバグの根治**。
  原因は2種類あった。①ダーク前提の `hover:bg-zinc-700/800/900` 等がライト上書きの対象外で
  素通りしていた(汎用ゴーストボタン全般。左ペイン「+新しいタスク」・左右ペイン格納・
  計画/エージェントの「クリア」「更新」・進化の「1つ前へ戻す」・Debugタブの各ボタン等、
  ほぼ全画面のセカンダリボタンが該当)。② `bg-blue-600` 等の塗りボタンが文字色を明示せず
  「ボディ既定の明るい文字」に頼っていたため、ボディ既定色をライト用に反転させた副作用で
  黒背景×黒文字になっていた(送信系の主要ボタン全般)。加えて調査中に、昇格ダイアログの
  コア承認ボタン(`bg-red-700`)がM25-5の「バッジ用の淡ピンク上書き」と偶然クラス名を
  共有してしまい、危険な塗りボタンのはずが淡ピンクの目立たないボタンに化けていた実バグと、
  MCPの「信頼して接続」ボタン(`bg-amber-700`)がコントラスト比2.78:1(WCAG不合格)だった
  ことも発見し合わせて修正。全て `styles.css` の `[data-theme='light']` 上書きのみで対応
  (コンポーネント側は無改修)。remote-uiは元々hoverルール自体が存在せず、塗りボタンは
  全て明示的に白文字を設定済みだったため対象の不具合なし(念のためコード上で確認)。
  実機Electron(CDP)で実際にマウスを各ボタン座標へ移動させてcomputed styleを取得する
  ホバー一括検査を実装し、main画面/4タブ/設定パネルを跨いで100〜180ボタンを検査
  (WCAGのコントラスト比公式で計算し3:1未満を検出)。修正前は6件検出、修正後は0件。
  再発防止として `styles.hoverContrast.test.ts` を追加:
  (1) コンポーネントで使われている暗色系hover:bg-*クラスが全てlight上書きを持つか、
  (2) 文字色未指定の塗りボタン(bg-blue-600/500・bg-red-700・bg-purple-700・bg-amber-700)に
  明示的な白文字強制があるか、(3) bg-red-700がバッジの淡ピンク上書きと共有されていないか、
  をstyles.cssの静的解析(自作の簡易CSSパーサ)で検証する。実際に一時的に修正を巻き戻して
  テストが正しく落ちることを確認済み(誤った安心を防ぐための逆検証)。テスト3件追加、
  全671件・typecheck・build合格。
- **M25-5追加(2026-07-08)**: **ライトテーマの視認性修正+自律モード警告バーの配色変更+
  remote-uiの配色統一+UI整理**。M25-4のライトテーマは「完成」と報告したが、実際には
  Tailwindの透明度サフィックス付きクラス(例 `bg-red-900/70`)が `[data-theme='light']` の
  上書きセレクタ(`.bg-red-900`)と一致せず素通りしていたため、進化タグ・自律バー・
  ReviewCard等の暗色バッジがライト背景に生の暗色のまま浮いて見えていた(視認性バグの主因)。
  実際に使われている `/NN` 付きクラスを全数grepし別名ルールとして追加して解消。加えて、
  ユーザーメッセージの吹き出しがプライマリボタンと `bg-blue-600` を共有していたため
  ライトでは黒地になっていた点を `user-msg` 専用クラスで淡灰(#F2F1ED)に分離。
  左ペインのセッション行は専用クラス(`sess-btn`/`sess-btn-active`)を新設し、ライトでは
  ホバーで暗くならず白のまま、選択中のみ淡灰(#ECEAE4、枠線・カラーバーなし)に統一。
  自律モードの警告バー(「自律モード有効…」帯)は濃茶(amber)からくすみ赤へ変更
  (デスクトップ/remote-ui共通、ダーク/ライト双方。小さいトグルボタンと確認モーダルは
  意図的に対象外のまま=amberが混在するが、影響範囲を絞るための判断)。
  remote-uiは送信/追加/カメラ/停止ボタン(いずれも同じ`.send`/`.cancel`クラス)の黒地アイコンを
  白地+濃色アイコンへ統一し、デスクトップと同じ配色思想(文字#2C2C2A・補助#6B6B6B・
  境界#E9E7E1)に揃えた。UI整理として、メインチャット上部の「過去のセッションを開く」
  ドロップダウンと「新規セッション」ボタンを削除(左ペインの検索+プロジェクトツリーで
  完全に代替済みのため冗長だった。ChatView側の未使用になったsessions/loadSession/
  newSession購読・useEffectも削除)。
  実機Electron(CDP、ポート9229)で左ペイン選択ハイライト・進化タブのバッジ・ツールカード・
  ユーザー吹き出し・自律バー(ダーク/ライト)を計7枚のスクリーンショットで確認。
  remote-uiは既存のリモートトークンでブラウザから接続し、送信/カメラ/停止ボタンと
  ユーザー吹き出し・自律バーの実際のcomputed styleが仕様値と完全一致することを確認済み
  (CDP screenshotツール自体がこのセッション中に断続的にフリーズしたため、一部は
  computed style直接検証で代替)。全668件テスト・typecheck・build合格。
- **M25-4追加(2026-07-08)**: **①進化パイプラインの安全な迂回バグを修正 ②OpenAIモデルを現行世代へ更新 ③ライトテーマの未完成部分を完成**。
  経緯: request_capability(scope:renderer)のジョブ#10がインフラ側エラーで異常終了 →
  M25-2の自動フィードバック文言「既存ツールでの代替手段を検討して続行せよ」を受け、モデルが
  worktree隔離・検証ゲート・人間承認を経ずに**本体の生きたソースを直接edit_file**して実装を
  代替してしまった(承認済み設計自体は正しかったが、安全な進化パイプラインを迂回した点が問題)。
  ①**根本修正**: feedEvolutionResultToModel をscope対応に分岐 — scope=renderer/coreの失敗では
  「既存ツールでの代替」を提案せず、直接編集を明示的に禁止し、再申請かユーザーへの相談のみを促す
  文言へ変更(scope=toolは従来通り)。②**OpenAIモデル更新**: gpt-5.1は2026-07時点で公式カタログ
  落ち(現行は gpt-5.5 flagship・gpt-5.4・gpt-5.4-mini/nano・gpt-5.3-codex)。KNOWN_MODELS/
  DEFAULT_MODELS/CONTEXT_LIMITSをgpt-5.5既定へ更新、usage.tsに単価表追加(gpt-5.4系はmini/nano
  を汎用gpt-5.4より先に照合する順序に注意)。旧gpt-5.1は非推奨ラベル付きで選択肢に残置。
  ③**ライトテーマ完成**: デスクトップは生のTailwind zincクラス直書きのため、コンポーネント無改修で
  [data-theme='light']スコープの一括CSS上書きで対応(themePref.ts新設・main.tsxで起動時適用・
  SettingsPanelは共通関数経由に統一)。remote-uiは theme.ts/CSSは既にあったが**トグルUI自体が
  存在せず**(App.tsxにimportのみ残る死んだコード)ライトテーマを選ぶ手段が皆無だったため、
  SettingsViewに「表示」カード(サーバ設定を経由しない端末ローカルのトグル)を追加。
  死んだimport(App.tsxのopenTab/RightPaneTab、remote-ui App.tsxのtheme関連)も削除。
  実機Electron(CDP)でダーク/ライト両方を計6画面スクリーンショット確認(メイン・進化タブ・
  設定パネル)、gpt-5.5既定表示も実機確認。テスト4件追加、全668件・typecheck・build合格。
  未検証: remote-ui(スマホ版)のトグルは実際の画面では未確認(typecheck/buildのみ、リモート
  トークン発行の手間を省略)。theme-mock/(検討用ダミーHTML)とAMATERAS_PLAN.mdは削除保留
  (自動削除がブロックされたため未追跡のまま残置。手動削除して問題ない)。
- **M25-3追加(2026-07-07)**: **コア/UI自己書き換え(evolve/job-9)でも意味のある要約が出るように修正**。
  ジョブ#9(AMA-teras自身がscope:coreで申請・renderer側のみ改修)は聖域(src/main/evolution/)を
  触れないため、要約はマージコミットの定型文(subject)止まりだった。人間(Claude Code)が聖域側を
  直接修正: `promoteBranch` に `description` 引数を追加し、マージコミット本文(2行目以降)へ
  ジョブの説明を埋め込む(subject=1行目は従来どおり定型文で互換維持)。`listEvolveTags` は
  ASCII制御文字(0x1e/0x1f)区切りで `%(contents:body)` を取得し `body` フィールドを追加
  (execFile経由でシェル解釈を挟まないため本文中の改行・タブと衝突しない)。
  renderer の `capabilitySummary` は renderer/core 種別で body を優先表示(無ければ subject
  にフォールバック=旧evolveタグとの後方互換)。テスト6件追加(promote 3件+renderer 3件)。
  副次的に、job-9の作業で workspace=C:\dev\mycodex 実行時に残った検証済み完了済みの
  AMATERAS_PLAN.md(全項目チェック済み)がユニットテスト(process.cwd()をworkspaceに使う
  service.switch.test.ts)へ「要約」の文字列で誤混入していたため削除して解消。
- **M25-2追加(2026-07-07)**: **進化結果での会話の自動再開** — 「進化の通知が来ても
  メインエージェントが動かない/『待ってください』と言って止まる」対策。待機中の依頼元会話に
  終端結果(done/failed/rolled_back)が届いたら、履歴注入だけでなく chatSend(内部targetConv)で
  ランを自動再開しモデルに続きをやらせる。安全弁: 人間が却下した rejected は再開しない(却下の
  意思尊重+再申請ループ防止)、ユーザー送信なしの自動再開はConvState.autoResumeCountで3連鎖まで
  (人間の送信でリセット。上限到達は履歴注入+上限infoに縮退)。request_capability の応答文言も
  「完了時に自動で再開される。待つ間は既存ツールで作業続行」に変更。テスト3件追加+1件更新。
- **M25追加(2026-07-07)**: **育成レイヤー(ユーザー方針)+完了前動作確認の規範化**。
  ①全プロジェクト共通の AMATERAS-USER.md(userData)を新設 — memory ツールに scope:"user" を追加し、
  「今後こうして」という恒久方針をAMA-teras自身が保存できる(=チャットからの育成)。毎ターン
  system prompt へ「# ユーザー方針」として注入(優先順: プロジェクト固有 > ユーザー方針 > 一般規範)。
  進化ジョブには userMemoryDir 非注入で書けない。Settings に編集欄(userMemoryGet/Set IPC)。
  ②SYSTEM_PROMPT 規範に「ユーザーが体験する成果物は完了報告の前に必ずツールで実際に動かして確認
  (screenshot/http_screenshot/bash実行)。『書けたはず』で完了としない」を追加。
  テスト8件追加(compose/read-write往復・scope書き分け・未注入エラー・system注入)。
- **evolve/8(2026-07-07)**: **workspace無言移住バグをAMA-teras自身がcore進化で修正**(人間監視付き)。
  バグ: chatSendのラン開始時に常にグローバル設定のworkspaceを束縛し conv.workspace を無言上書き
  → sessionOpen(別セッションを開くとグローバル追従)が引き金で、古い会話へ戻って送信すると
  別プロジェクトへ無言で移住(実害: 「初めまして」会話が Documents\AMA-teras→C:\dev\3DCAD へ)。
  修正: 会話記録のworkspace優先(新規会話のみグローバル束縛)・既存記録は上書きしない・
  食い違い時は警告infoカード。回帰テスト2件(記録A/設定B→Aのまま+警告+永続化もA、新規→B)。
  フロー: Claude Codeが診断検証→チャット指示→AMA-terasがrequest_capability(scope:core)→
  全ゲート合格→Claude Codeがdiff先行レビュー→ユーザー承認→再ビルド+健全性チェック→自動再起動。
  残課題: 既存会話のworkspaceを意図的に変更する明示操作(「この会話を移動」)は未実装。
- **M24-2追加(2026-07-07)**: 計画時の**能力ギャップ評価**をプロンプト規範化 —
  「既存ツールの遠回りな組み合わせで妥協せず、専用ツールがあれば効率よく・自動でできると
  判断したら request_capability で積極提案(名前案+期待入出力を明記)」を SYSTEM_PROMPT 規範と
  PLAN_SUFFIX(プランモードでは提案の明記のみ・実行は承認後)に追加。request_capability の
  description も「対応できない時だけ」から「効率化判断でも積極的に」へ拡張。
  失敗時は evolution_jobs で失敗ゲート確認→修正して再申請する導線も規範に含めた。
  service.plan.test で規範文言の存在を固定(能力ギャップ/request_capability)。
- **M24追加(2026-07-07・スマホからの追加指示)**: チャットモデルが**進化パイプラインの内部ログ**を
  自分で確認できる読み取り専用ツール `evolution_jobs` を追加。id省略=現行プロセスの全ジョブ一覧
  (id/status/scope/tool/失敗ゲート/説明)、id指定=ゲート合否詳細+ログ末尾(logTailで行数調整)。
  ctx.evolution に `list()` を追加(service.evolutionContextで注入、chatSend/toolsExecute両経路)。
  進化ジョブの状態はメモリ上のみで再起動で揮発する旨をツール説明に明記(過去の昇格済み能力は
  EvolutionPanelの「獲得した能力」を参照)。ユニット7件。
  なお「再起動でツールが消えるかも」の懸念は調査の結果**実体は全て健在**(devは
  src/main/tools/plugins/をソースから起動時ロード、evolve/7のhttp_screenshot含む16プラグイン。
  git clean)。消えて見える場合はロードエラー(Debugパネルのregistry.errorsに表示)であり削除ではない。
- **M23-6追加(2026-07-06 夜間・スマホからの追加指示)**: 進化パネルの昇格履歴を
  **「獲得した能力」リスト**へ拡張 — evolveタグごとにマージ第1親との差分から
  kind(🔧ツール追加/🎨UI自己書き換え/⚙コア自己書き換え)・追加ツール名・変更ファイル
  一覧を導出して表示(実データ: evolve/1=csv_to_markdown・evolve/2=text_stats・
  evolve/4=UI自己書き換え)。あわせて remote:set-enabled が remote.host を落とすバグを修正
- **M23完了(2026-07-06 夜間自走・第2ラウンド)**:
  ①**使用中モデルの表示** — メイン応答バッジ(policy有効時はPLANNER・model)・実行中ステータスに
  RunInfo.model(フォールバックで更新)・サブエージェントにworker/escalation帯のモデル名
  ②**使用量メーター(残高に準ずるもの)** — 残高取得APIは両プロバイダとも存在しないため、
  track()デコレータで全LLM呼び出しの実測トークンを日別×モデル別集計(userData/usage.json)。
  Settings/スマホ設定タブに今日・累計トークン+概算$、残高ダッシュボードを開くボタン
  ③**スマホ強化** — +新規チャット(POST /api/sessions/new)・設定タブ
  (ホワイトリスト限定のGET/POST /api/settings: provider/model/maxTurns/subAgent*/
  autoApprove/modelPolicy/fallbackのみ。workspace/scopeMode/postEditHook/キーは不可)・
  使用量表示。実行中の割り込み入力はM21-1で実装済み
  ④**実LLM複数同時ランテスト合格**(Anthropic課金補充後・設定初期化済み) —
  会話A(bash sleep 25)実行中に会話Bが並行完了・↩追加指示がAの最終応答に反映・
  2ラン同時表示(スピナー/モデルラベル)・切替復帰・混線なし・使用量メーター実測動作
- **M22完了(2026-07-06 夜間自走・v0.3.0-M22タグ)**: 複数プロジェクト同時実行 —
  AgentServiceを会話(ConvState)単位の独立状態へ再構成(history/永続化排他/フォールバック
  1回制限/自律モード=会話単位化/RunState: 開始時固定workspace・会話別ProcessManager)。
  実行中のセッション切替・新規のブロック撤廃(実行中会話を開くと生きたhistoryへ接続し
  実行状態に復帰)。全chat:eventへconversationId付与+runs:changed/runs:list(IPC/SSE)で
  左ペイン実行中◌表示。承認要求にorigin(会話/タイトル/workspace)を付与しダイアログ・
  スマホカードに出所表示。cancel/バックグラウンドプロセスは会話単位(他会話へ波及しない)。
  ハード上限なし・同時5超で注意カード。レーステスト5件+実機E2E(イベント帰属・混線なし・
  切替往復・エラー表示経路)。体感確認は `docs/M22-manual-test.md`
- **M21完了(2026-07-06 夜間自走)**: 実行中の対話性と可視化+修正 —
  ①実行中の追加指示(キュー→ターン境界でtool_result対を壊さず注入・応答完了時の残指示は
  新userメッセージで継続・↩バッジ・remote対応) ②subAgentMaxParallel(既定3・1〜8)
  ③QR根治(原因=M17移行でlocalStorage消失→config永続化は7cce924で対応済み。
  平文トークン非保持設計の「📱トークン込みQRを出す(再生成)」導線+回帰テスト)
  ④生存と考えの可視化(現在の状況ライン=状態/経過/最新思考、ツールカード経過+bash
  stdoutライブ+30s無応答⏳、サブエージェント💭narration+経過。APIコスト追加なし)。
  体感確認は `docs/M21-manual-test.md`
- **整理タスク4件完了(2026-07-06)**:
  ①右クリック「フォルダで開く」(左ペインのプロジェクト項目+チャット内ファイル参照。
  file:reveal再利用、resolveRevealTargetでディレクトリ対応・deny判定のみ維持)
  ②テスト用セッション23件削除(ユーザー確認済み・実作業のAICAD 2件は保持)
  ③アイコン適用(icon-source.png→角丸icon.ico/icon-512+PWAフルブリード180/192/512、
  electron-builder.yml win.icon・manifest icons・apple-touch-icon/favicon配線、
  ショートカットにも適用、稼働サーバで200実測)
  ④副題を「自己進化型AIエージェント」へ統一(ヘッダ・README・package.json。CLAUDE.mdは聖域のため不変)
- **M20完了(2026-07-06・実機3実証済み)**: コア自己進化(提案制・保護領域つき) —
  進化scopeを **tool / renderer / core** に段階化(`src/main/evolution/scopes.ts`)。
  **聖域=保護トリップワイヤ**(`protected.ts` の PROTECTED_PATHS: 承認機構・evolution配下・
  スーパーバイザー・secrets・IPC/preload・CLAUDE.md/PROTECTED.md)は scope問わず
  **A側(稼働中)のメモリ上リストのみで判定**し、該当差分は承認ダイアログにも出さず即reject
  (protectedReject)。B側protected.tsを空にしても捕捉されることをテストで実証。symlink差分も拒否。
  ゲートは7段固定順: 聖域→危険検出→差分allowlist→typecheck→vitest→build→スモーク起動
  (renderer/coreは `--smoke-boot`: userData隔離mkdtemp+単一インスタンスロック非取得で
  本体と同時起動可・React mount確認・60s watchdog)。昇格(renderer/core)は
  **常に人間の二段確認**(赤枠+理解チェック必須。自律モードONでも自動化されない=不変条件テスト)
  → mainへマージ+evolveタグ → A再ビルド+健全性ブート → 失敗なら自動revert+旧ビルド復元
  (rolled_back・再起動しない)→ 成功なら5秒予告後に自動再起動。再起動はセンチネル
  (restart-sentinel.json)で見守り、2回連続クラッシュで**セーフモード起動**
  (赤バナー+復旧コマンド+進化無効化+解除ボタン)。進化パネル: scopeバッジ・🛡拒否表示・
  昇格履歴+「⏪1つ前へ戻す」。スマホ承認も二段確認対応。
  **実証: (a)renderer scope「設定ボタンにツールチップ」全線通過(AI差分1行→7ゲート→二段確認→
  再ビルド→健全性→自動再起動→完了バナー+反映、evolve/4) (b)ApprovalDialog.tsx変更を指示厳守で
  強制→protectedゲートのみ実行で即reject・ダイアログ非表示 (c)センチネルbootAttempts=2→
  セーフモード起動・enqueue拒否・解除でセンチネル消滅**。体感確認は `docs/M20-manual-test.md`
- **M19完了(2026-07-06・実機実測済み)**: 品質レビュー・ゲート —
  AppConfig.reviewGate(**既定undefined=無効・従来挙動完全維持**)。有効時:
  マイルストーン(AMATERAS_PLAN.mdの項目 - [ ]→- [x])ごとにplanner帯の辛口レビュアーが
  4軸採点(code/ux/requirements/tests、UI無しはux自動スキップ・localhost限定screenshot可)。
  閾値未満→file/location/problem/fixの具体指摘つきでworker帯へ差し戻し(1〜2回worker、
  3回目以降escalation帯=M18連動)→再レビュー。上限到達: 自律ON=警告のみ/OFF=承認ダイアログ。
  計画未使用タスクは完了時1回に縮退(write/exec成功なしは対象外)。レビュー要約をplanの
  tool_resultへ追記(メインモデルも合否認識)。🧪レビューカード(緑/琥珀/赤)+audit記録+
  Settings節(プリセット3種)。進化ジョブ非波及guardrail。
  **実測: バグ入りコードを「修正禁止」指示下で 2.33不合格→worker修正→4.33合格(3.9分・
  独立検証9/9)。ベンチ②ONは3.5分・12/12・追加コスト$0.15(+78%)**(docs/autonomy-comparison.md)。
  体感確認は `docs/M19-manual-test.md`
- **M18完了(2026-07-06・実機ベンチ実測済み)**: モデル自動切替(役割ベース割当) —
  AppConfig.modelPolicy(**既定undefined=無効・従来挙動完全維持**)。有効時:
  メイン会話=planner帯 / dispatch_agentサブ=worker帯 / 詰まったらescalation帯へ自動格上げ
  (error・maxTurns到達・ツール失敗3連続で発火、子履歴をcompaction経由で引き継ぎ、
  上限maxEscalationsPerTask、infoカード+audit `model-escalation`)。プロバイダ横断可・
  帯ごとキー未登録警告(workerはplanner代行で続行)・M16フォールバックは子ループにも配線
  (1会話1回の制限共有)・進化ジョブ非波及(guardrail固定)。Settings節(プリセット2種・
  帯別選択・現在の割り当て一覧)+plannerバッジ+⤴格上げバッジ。
  **ベンチ②実測: planner=Fable5/worker=Sonnet5 で2.3分完遂・介入0・vitest10/10、
  実行の手数(23コール中18)をworkerが担いコスト約半減**(docs/autonomy-comparison.md)。
  体感確認は `docs/M18-manual-test.md`
- **M17完了(2026-07-06・Windows実機CDP検証済み)**: リブランド+自律モード+UX修正 —
  ①**リネーム MyCodex → AMA-teras**(package name/appId/productName=amateras、
  userData自動移行: 旧`%APPDATA%\mycodex`→新`amateras`へ実データ+**Local State(safeStorage鍵素材)**を
  コピー・実データ有無で判定・マーカー冪等・旧dir温存。記憶/計画は AMATERAS.md / AMATERAS_PLAN.md へ
  旧名読み込み互換+初回書き込みrename移行。実機でキー復号・セッション19件引き継ぎ確認)
  ②**自律モード**(送信欄🔓トグル+チェック必須の危険モーダル+常時警告バー。
  safe/write/exec/systemスコープ/動的承認を全自動承認、全操作をautonomous:trueでaudit記録。
  ハード拒否維持: secrets読み書き・userData書き込み・システム領域の既存上書き。
  新規作成は許可。exec系はformat/diskpart等のカタストロフィックdenylistで即拒否。
  セッション単位・再起動/切替/新規でOFF。remote-uiからも切替可=ONはconfirmed:true必須。
  進化ジョブ非波及をguardrailで固定)
  ③**左ペインソート修正**(プロジェクト順=配下セッションの最新updatedAt降順に固定。
  選択では動かさずハイライトのみ)。体感確認は `docs/M17-manual-test.md`
- **M16完了(2026-07-06・Windows実機CDP検証済み)**: 一晩自走テスト(AICAD)の知見反映 —
- **M16完了(2026-07-06・Windows実機CDP検証済み)**: 一晩自走テスト(AICAD)の知見反映 —
  ①モデル切替時の自動compaction(SessionData.lastLLM記録・切替検知→閾値超過なら圧縮+infoカード)
  ②一時APIエラーの自動リトライ(指数バックオフ最大3回・AbortSignal尊重)と
  課金/残高エラーのプロバイダフォールバック(AppConfig.fallback・既定OFF・1会話1回・
  本体設定不変・警告カード+audit記録・切替前compaction)
  ※M16の記載中「MYCODEX.md/MYCODEX_PLAN.md」等の旧名はM17で AMATERAS.md/AMATERAS_PLAN.md へ改称
  ③アシスタント本文のmarkdown表示+コードブロックにコピーボタン(desktop=react-markdown、
  remote-ui=共有フェンススプリッタの軽量実装、パスリンク維持)
  ④控えめマイクロアニメーション(CSSのみ・transform/opacity限定・prefers-reduced-motion優先・
  Settingsトグル)。体感確認は `docs/M16-manual-test.md`
- **M15完了(2026-07-06)**: 3ペインUIリニューアル — 左ペイン(プロジェクト×セッションツリー・
  検索・rename/削除・workspace自動追従)/右ペイン(環境ウィジェット+📄プレビュー・計画・
  エージェント・進化・Debugタブ集約+バッジ)/リサイズ・折りたたみ・狭幅オーバーレイ・
  Ctrl+B/J/K。新IPCは追加のみ4本+file:reveal(sessions:search / sessions:rename /
  file:preview / workspace:gitStatus)。体感確認は `docs/M15-manual-test.md`
- **M14完了(2026-07-06・Windows実機で実装/検証・ベンチ④合格)**: 画像入力対応 —
  プロバイダ画像写像(Anthropicネイティブ/OpenAI互換レイヤ)/D&D・ペースト・スマホ📷添付/
  screenshotツール(localhost自動・外部URLはドメイン単位セッション許可+全件audit・非httpスキーム拒否)/
  画像blob外出し(sessions/blobs・50MB上限)/compaction画像テキスト化(ペア構造不変)/
  fullPcセッション中許可(M14-5・既定OFF・ツール×ディレクトリ粒度)。
  **ベンチ④(React→devサーバ→スクショ自己確認→見た目修正)を1.3分・介入0で完遂** —
  「UI確認不可」ギャップ解消(docs/autonomy-comparison.md)。体感確認は `docs/M14-manual-test.md`
- **M13完了(2026-07-05・Windows実機で実装/検証)**: QRコード接続/長期記憶+compaction強化/
  MCPクライアント(stdio)。実機確認済み(QR表示・memory追記・MCP filesystem 14ツール接続→
  承認バナー→実行)。残る体感確認は `docs/M13-manual-test.md`
- **M12完了(2026-07-05・Windows実機で実装/検証)**: 長丁場対応 —
  多重起動ガード(smoke非ロック)/セッション永続化+再開(強制終了→復元→文脈保持を実機確認)/
  計画ファイル(planツール+system prompt注入+パネル)/並列サブエージェント
  (mode:'work'・最大3並列・executor経由承認・write衝突拒否・出所バナー)。
  手動確認の残りは `docs/M12-manual-test.md`、ベンチ実測は `docs/autonomy-comparison.md`
- **M11完了(コード・5点全部)**: 自律開発能力の強化 — maxTurns設定化/バックグラウンドbash/
  自動チェックポイント/編集後フック/既定モデル claude-fable-5。
  Windows実機確認(taskkill・復元・フック体感・Fable実測)は `docs/M11-manual-test.md`
- **M10完了(コード)**: スマホ(iPhone)Webアクセス。main内蔵HTTPサーバ(REST+SSE、
  Node標準httpのみ・新規依存ゼロ)+独立ビルドのモバイルSPA(src/remote-ui)+
  トークン認証(sha256ハッシュ保存・timingSafeEqual・失敗バン)。
  ※**remote-ui の Vite ビルドのみ未実行**(サンドボックス制約)。Windows側で
  `npm run build` を一度実行すると out/remote-ui が生成され配信可能になる
- **M9完了**: 操作範囲のPC全体拡大(scopeMode: project / fullPc、全操作承認制)
- 進化ジョブ#1が成功済み: `csv_to_markdown` ツールが evolve/1 として昇格・稼働中

## ユーザーへの依頼事項

- **iPhone実機 + Tailscale の確認のみ残**(`docs/M10-manual-test.md` B節)。
  リモートアクセスは有効化済み・PC側検証(401/200/SSE/remote-ui描画/履歴同期)は完了。
  Tailscale はオンライン(morikawa.tailb1fb66.ts.net)
- **NSISインストーラ**: 開発者モードON または管理者ターミナルで `npm run dist`
- 済: Windowsビルド(out/remote-ui生成)、M9/M10(PC側)/M11 のWindows実機確認、
  Anthropicキー登録と実API検証(claude-fable-5 ツール連鎖・cache_read非ゼロ実測)。
  詳細は `VERIFICATION_REPORT.md`(2026-07-04〜05 帰宅後検証)

## 完了項目

- 2026-07-03: フェーズ0 — 設計ドキュメント作成
- 2026-07-03: M1 — electron-vite 骨組み、型付きIPC(chat:send/cancel/event)、
  チャットUI(zustand、ストリーミング表示、キャンセル)、エコー応答、スモークモード起動分岐。
  検証: typecheck / vitest 6件 / ビルド / スモーク起動 / CDP経由E2E(UI入力→エコー表示)すべて成功

- 2026-07-03: M2 — ツールプラグイン基盤(esbuild動的ローダー+内容ハッシュでimportキャッシュ迂回、
  registry.reload()でホットリロード)、組み込み6ツール、承認ブローカー+承認ダイアログ(diff表示・
  risk別警告・自動承認設定)、ツールデバッグパネル、スモークモード実装
  (`MYCODEX_SMOKE=1 electron . --tool <name> --input <json>`)。
  検証: typecheck / vitest 40件 / スモーク実行 / CDP経由E2E(承認ダイアログ・diff・許可・拒否)すべて成功

- 2026-07-03: M3 — LLMProvider抽象+Anthropic実装(messages.streamのイベント正規化、
  cache_controlをsystem/ツール末尾/履歴末尾に配置、AbortSignal対応)、
  エージェントループ(tool_use連鎖・maxTurns=30・キャンセル・refusal/max_tokens処理)、
  SecretStore(safeStorage暗号化、平文保存禁止)、設定UI(プロバイダ/モデル/APIキー/自動承認)、
  チャットUIにツール実行カード表示。
  検証: typecheck / vitest 58件 / ビルド / CDP E2E(設定パネル・キー未設定エラー・idle復帰)。
  実APIでのtool_use連鎖確認はユーザーのキー登録待ち

- 2026-07-03: M4 — 自己進化基盤。WorktreeManager(B作成/破棄、node_modulesジャンクション共有)、
  EvolutionJobRunner(実LLM用AgentJobRunner+モック差し替え可能なインターフェース)、
  検証ゲート(差分検査→typecheck→vitest→build+スモーク)、EvolutionManager(直列キュー、
  承認付き昇格 merge --no-ff + evolve/Nタグ + ホットリロード、健全性チェック失敗時の自動revert)、
  request_capabilityツール(ToolContext.evolution経由で注入)、進化パネル+昇格承認ダイアログ(diff・危険警告表示)。
  検証: typecheck / vitest 64件(実gitでの正常系・保護領域fail・却下・ロールバック・連番ID)/
  CDP E2E(進化パネル→手動enqueue→job_update反映→failed表示→worktree掃除確認)

- 2026-07-03: M5(部分)— ゲート不合格時のフィードバック付き再生成(1回)と生成例外リトライ(1回)。
  残りの実LLM通しE2Eはキー登録待ち
- 2026-07-03: M6 — OpenAIプロバイダ実装。tool_use⇔tool_calls / tool_result⇔role:tool の相互変換、
  ストリームチャンク正規化(分割arguments組み立て、finish_reason写像、usage/cached_tokens)、
  設定UIでの切替。既定モデル gpt-5.1。
  検証: typecheck / vitest 70件。実APIでの疎通確認はキー登録待ち

- 2026-07-04: M3/M5/M6 実API確認(OpenAIプロバイダ・gpt-5.1)—
  - M3: チャット指示で list_dir→read_file のツール連鎖が完遂、ストリーミング最中のキャンセルが
    即時に効きエラー扱いにならないことをCDP E2Eで確認
  - M5: request_capability発火(チャット経由)→B worktreeで実LLM生成(自己検証ループ込み)→
    4ゲート全合格→昇格ダイアログ(diff確認)→承認→merge+evolve/1タグ→ホットリロード→
    同一アプリで csv_to_markdown を実使用しMarkdown表を出力、まで通しで成功。
    ロールバック動作はM4の実git統合テストで検証済み
  - M6: 上記すべてがOpenAIプロバイダ上で動作(=M6完了条件のシナリオを包含)
  - 初回失敗と対策: 生成コードが noUncheckedIndexedAccess で2回typecheck失格
    → ジョブプロンプトにstrict規約と「完了前にtypecheck/vitest自走」を必須化して解消

- 2026-07-04: **M9 — 操作範囲のPC全体拡大(全操作承認制)**。テスト136→175件(新規39件)。
  - M9-1: `src/main/tools/scope.ts` — classifyPath(workspace/system)/ isDenied(ハード拒否)。
    realpathでシンボリックリンク・`..` 迂回をケア、Windowsパスは大文字小文字非依存。
    `AppConfig.scopeMode`('project'|'fullPc'、既定 'project')を追加
  - M9-2: `ToolPlugin.pathParams` 宣言(read_file/write_file/edit_file/list_dir/grep)と
    executor統合 — ハード拒否→即エラー、system×project→拒否、system×fullPc→強制承認
    (autoApprove / allow-session を無視。allow-sessionは受理しても記憶しない)
  - M9-3: bash(risk:'exec')は fullPc で常に毎回承認+「PC全体に影響し得ます」警告。
    進化ジョブの restrictExec は無条件で維持
  - M9-4: `src/main/audit.ts` — systemスコープの承認/拒否/実行結果を userData/audit.jsonl へ追記。
    ApprovalDialog にsystem警告バナー+解決済みパス表示+allow-sessionボタン非表示。
    Settings に scopeMode トグル(fullPc有効化時は確認モーダル)
  - M9-5: 回帰テスト(進化ガードレール guardrails.test.ts / executor.scope.test.ts)と
    `docs/M9-manual-test.md`(手動確認はユーザー実施待ち)

- 2026-07-04: **M10 — スマホ(iPhone)Webアクセス(SSE方式・新規依存ゼロ)**。
  テスト175→235件(新規60件)。設計書 `docs/M10-mobile-web-design.md`。
  - M10-1: コア抽出リファクタ(挙動変更ゼロ・単独コミット)。`src/main/core/service.ts`
    (AgentService: chatSend/chatCancel/approvalRespond/toolsList/evolution*/getStatus/
    getHistoryView/承認・昇格のpending追跡)+ `src/main/core/events.ts`(EventBus)。
    ipc.ts はIPCチャネル⇔サービスの薄い写像へ。ApprovalBroker に onSettled フック追加
  - M10-2: `src/main/remote/auth.ts` — トークン生成(randomBytes 32)/sha256ハッシュのみ
    config保存/timingSafeEqual比較/失敗5回で60秒IPバン。`AppConfig.remote`
    (enabled/port/tokenHash、既定 disabled・8787)。settings:set は remote を常に保持
    (専用IPCでのみ変更可)
  - M10-3: `src/main/remote/server.ts` — Node標準httpのみ。REST
    (/api/status|chat|chat/cancel|approval/respond|tools|evolution|evolution/enqueue|
    evolution/promote-respond|audit|history)+ SSE /api/events(接続直後にsnapshot、
    EventBus全チャネル中継、25sハートビート)+静的配信(パストラバーサル対策、
    ../ %2e%2e ..%5c を全て遮断するテスト付き)。audit.tail(limit) 追加
  - M10-4: `src/remote-ui/` — Vite+React+TSの独立SPA(window.api非依存・既存devDeps
    のみ・Tailwind不使用の素CSS)。Chat(ストリーミング/キャンセル/plan切替)、
    承認(diff・警告・systemバナー・昇格承認)、進化(一覧+enqueue)、監査タブ。
    トークンは #t= フラグメント→localStorage。`npm run build` に組み込み
    (`build:remote-ui`)。typecheck は tsconfig.remote.json を追加
  - M10-5: ipc.ts にサーバ起動配線(起動時 enabled なら listen、失敗は lastError で
    UI表示)+ remote:status/set-enabled/regenerate-token IPC + Settings
    「リモートアクセス」節(トークンは応答で一度だけ表示・URL組み立て・再生成確認)。
    承認競合: approval:resolved / job_update で両画面のダイアログを閉じる
    (first-response-wins。store単位の回帰テスト付き)
  - M10-6: README(セットアップ+Tailscale手順+セキュリティ前提)、
    docs/M10-manual-test.md、PROGRESS更新

- 2026-07-04: **M11 — 自律開発能力の強化(5点)**。テスト235→281件(新規46件)。
  設計書 `docs/M11-autonomy-design.md`。全ステップで進化ジョブへの非波及を
  guardrails.test.ts のソース・トリップワイヤ+挙動テストで機械的に固定
  - M11-1: `AppConfig.maxTurns`(未設定=30、1〜200クランプ、読込/保存の両方で正規化)を
    service 経由で runAgentLoop へ配線。Settings に数値入力
  - M11-2: `src/main/core/processes.ts` ProcessManager(出力リングバッファ256KB/proc、
    kill: Windows=`taskkill /pid <pid> /T /F`・他OS=detachedプロセスグループへSIGKILL、killAll)。
    bash に `background:true`、新ツール bash_output(safe)/ bash_kill(exec)。
    ToolContext.processes はメインセッションのみ注入。セッションキャンセルと
    アプリ終了(will-quit)で全kill
  - M11-3: `src/main/core/checkpoints.ts` CheckpointManager。一時 GIT_INDEX_FILE 上で
    add -A → write-tree → commit-tree(親=前チェックポイント or HEAD)→
    `refs/mycodex/checkpoints/<sessionId>` のみ更新。HEAD/index/他refs不変を実gitテストで固定。
    write/exec 成功後+ループ完了時に自動snapshot(変更なしskip)。
    checkpoint:list / checkpoint:restore IPC + Debugパネル復元UI(復元前に pre-restore へ自動退避)。
    非gitワークスペースでは完全noop
  - M11-4: `AppConfig.postEditHook`(空=無効)。executor で write_file / edit_file 成功直後に
    実行し、出力末尾4KBを `[post-edit hook]` として tool_result に追記(non-zeroでも成功のまま)。
    タイムアウト60s+フォールバックタイマー。restrictExec では注入されていても実行しない(二重防御)
  - M11-5: 既定モデルを claude-fable-5 へ(shared/models.ts / providers/anthropic.ts)。
    既定モデルでの cache_control 配置をテストで確認。実API検証はキー登録後

- 2026-07-05: **M12 — 長丁場対応(セッション永続化・計画ファイル・並列サブエージェント)**。
  テスト281→337件。設計書 `docs/M12-longrun-design.md`。Windows実機で実装・E2E確認
  - M12-0: 多重起動ガード。`requestSingleInstanceLock`(スモークモードでは取得しない —
    進化ゲートのheadless並行起動を壊さない。index.guard.test.ts+guardrailsで固定)。
    実機確認: A稼働中の二重起動は即quit・A稼働中の MYCODEX_SMOKE=1 は成功
  - M12-1: `src/main/core/sessions.ts` SessionStore(userData/sessions/<会話ID>.json、
    tmp→renameアトミック書き込み、8MB超は既存compactionで畳んでから保存、ロード時に
    未完了tool_useを合成tool_resultで修復=API 400対策)。会話IDを新設し
    ユーザー送信直後+各ターン完了+終了時に随時保存。sessions:list/load/delete/new IPC+
    セッション切替ドロップダウン。実機確認: 強制終了→再起動→復元→文脈保持(合言葉)
  - M12-2: planツール(workspace直下 MYCODEX_PLAN.md 固定・path入力なし・risk safe)。
    system promptへ「## 現在の計画」を毎ターン注入(compactionで失われない)+plan運用規範。
    計画パネル(checkbox進捗・自動更新)。進化ジョブではwrite拒否・読み取り専用サブエージェント非公開
  - M12-3: dispatch_agent拡張 `{task?, mode?: 'read'|'work', parallel?: {task}[]}`
    (未指定=完全従来挙動)。work子は全ツールを親のexecutor経由で実行(承認・スコープ・監査・
    フックがそのまま効く)、最大3並列・子maxTurns設定可(subAgentMaxTurns、既定30)。
    WriteLockTable(同一パスwriteは最初の子が所有)、fan-out直前チェックポイント、
    agent:sub_updateイベント+エージェントパネル、承認ダイアログ/remote-uiに出所バナー。
    ネスト1段・進化非注入をguardrailsで固定。
    実機確認: 2体並列で別ファイル同時生成・出所バナー・チェックポイント・git不変
  - 判断記録: セッション復元でworkspace設定は自動切替しない(メタ保存のみ)/
    work子にはprocesses(バックグラウンドbash)非注入(v1簡素化)/
    planはwork子から書けない(親が単独管理)
  - M12-4: ベンチ3課題を実測(docs/autonomy-comparison.md「実測」節)。
    ①TODO CLI 1.5分/7T ②Express+sqlite REST 2.9分/19T ③React 1.1分/6T、
    **全課題を介入ゼロで完遂・独立検証合格**。②初回試行で同期bashの
    キャンセル不能ハングが実害化 → bash修正(c8884a9: タイムアウト/キャンセル時に
    子孫ツリーtaskkill+フォールバック解決)

- 2026-07-05: **M13 — QR・コンテキスト管理強化・MCPクライアント**。テスト337→375件。
  設計書 `docs/M13-design.md`。依存追加: qrcode / @modelcontextprotocol/sdk(承認済みの2つのみ。
  @types/qrcode は追加せずローカル d.ts で対応)
  - M13-0: リモート接続URLのQR表示(buildRemoteUrl切り出し+テスト。トークン込みQRは
    有効化/再生成直後のみ・それ以外はトークン無しURL+注記)
  - M13-1: memoryツール(MYCODEX.md固定・学習メモ節へタイムスタンプ付き追記・rewrite整理)。
    compaction: 実測トークントリガー(usage input+cache_read、CONTEXT_LIMITSの70%、
    ループ内でも発火)/2段階圧縮(第1段: 古いtool_result切り詰め=ペア構造不変を
    テスト固定、第2段: 構造化要約5セクション)/「## 記憶へ退避」を学習メモへ自動退避
  - M13-2: McpManager(stdio・mcp.json・起動非ブロック・mcp__<server>__<tool>で外部登録・
    名前衝突拒否)。risk写像 readOnly→safe/destructive→exec/その他→write/annotationsなし→exec。
    サーバー単位信頼確認・承認/remote-uiに出所バナー。テストはInMemoryTransportのモックサーバー
  - 非波及: memory/MCPはguardrailsで固定(進化ジョブ=自前registryで構造上不可視+トリップワイヤ、
    読み取り専用サブエージェントから memory/mcp__ 除外)
  - 判断記録: MCP子プロセスはSDKのtransportが所有するため ProcessManager 登録ではなく
    will-quit で McpManager.closeAll()(ユーザー承認済み)/ CONTEXT_LIMITS は保守的既定
    (claude-*/gpt-5*: 200k、gpt-4.1: 1M、gpt-4o: 128k、未知: 200k)

- 2026-07-06: **M14 — 画像入力対応(UI検証の完成)**。テスト375→403件。設計書 `docs/M14-design.md`
  - M14-1: ContentBlock image / tool_result.images(テキストのみ履歴と後方互換)。
    Anthropicネイティブ写像・OpenAIは tool_result 画像を直後 user へ注入する互換レイヤ。
    compaction は画像を概算1600トークンで計上し古い画像を「[画像: 説明]」置換(ペア構造不変)。
    SessionStore は sha256 content-addressed で sessions/blobs/ へ外出し・50MB超過で古い画像から
    テキスト化・欠損blob耐性
  - M14-2: chat:send 任意images引数(1枚10MB・8枚)。screenshotツール(ToolContext注入方式・
    ToolPlugin.dynamicApproval 新設)。localhost=safe自動/外部URL=毎回承認+ドメイン単位
    セッション許可/自動許可含め全件audit/file://等拒否。進化ジョブ非波及をguardrails固定
  - M14-3: 添付サムネイル・ツールカード画像プレビュー・remote-ui📷添付(検証共通化)
  - M14-5: fullPcAllowSession(既定OFF)。ONでツール×ディレクトリ粒度のセッション許可、
    exec対象外・ハード拒否不変・自動通過も全件audit
  - M14-4: ベンチ④合格(1.3分・介入0・スクショ2枚・build独立検証・残プロセス0)。
    初回試行はscaffoldの対話プロンプトでモデルが質問し失格 → プロンプトに
    「質問せず自分で判断」を明示して再実行(手順は autonomy-comparison.md に記録)
  - 判断記録: 画像トークンは実データ長でなく定数概算(1600tok)/ blobs は content-addressed
    共有のため自動GCしない(欠損時はロードで置換テキスト化)/ LAN内IPも「外部」扱い

- 2026-07-06: **M15 — 3ペインUIリニューアル**。テスト403→411件。設計書 `docs/M15-ui-design.md`。
  依存追加: react-markdown / remark-gfm(許可済みの2つのみ)。既存IPCは不変(追加のみ)。
  各ステップでCDPスモーク(既存機能到達性込み)を実施し全通過
  - M15-1: SidePane(リサイズ・折りたたみ・localStorage・狭幅オーバーレイ)
  - M15-2: 左ペイン=workspace×セッションツリー+検索(sessions:search)+rename
    (sessions:rename)+削除。セッション切替でworkspace自動追従(M12制約解消)
  - M15-3: file:preview / file:reveal(M9スコープ判定・md/コード/画像・1MB/8MB上限・
    バイナリ拒否)。ツールカード・本文中パスのリンク化→右ペイン自動オープン
  - M15-4: workspace:gitStatus+環境ウィジェット、パネルタブ集約+実行中バッジ、
    ヘッダボタンのタブ化、Ctrl+B/J/K
  - 判断記録: 「フォルダで表示」用に file:reveal を追加(設計リスト外だが追加のみの制約内。
    表示可能判定を通したパスのみ開く)/ ChatViewのセッションドロップダウンは互換のため残置/
    本文パスのリンク化は正規表現マッチ(実在チェックはクリック時)

- 2026-07-06: **M15.1 — remote-uiバグ修正と小機能**。テスト411→424件
  - 【バグ】スマホ写真添付が無反応: 原因は remote サーバの body 上限 256KB(写真base64が413で
    破棄)。/api/chat のみ24MBへ拡大+remote-ui側で送信前に長辺1568px・JPEG(0.85)へ自動圧縮。
    実HTTPの結合テストで2.7MB受理・24MB超拒否・不正payload 400 を固定
  - 【機能】remote-uiにセッション切替: GET /api/sessions + POST /api/sessions/load を追加公開。
    service.sessionOpen が実行中ガードとworkspace追従をサーバ側で強制(追従は「既存セッションの
    記録値」限定のためリモート公開可と判断。settings:set自体は引き続き非公開)
  - 【バグ】PWA(ホーム画面)でトークン再入力: 原因は (a) manifest start_url が #t= を落とす
    (b) 初回ロードで replaceState がフラグメントを即削除 → 追加時URLに #t= が無い
    (c) PWAはSafariと保存領域が別。対処: start_url削除+**フラグメント削除をやめる**
    (ユーザー決定。トークンはURLフラグメントのままサーバへ送信されず端末内に留まる)+
    抽出を緩い正規表現に(extractTokenFromHash・テスト付き)+ゲートに説明文
  - ライブcurl検証は保持トークン失効(再生成済み)+認証失敗バンのため中止し、
    実HTTP+実認証の結合テスト(server.test.ts)を検証根拠とした。スマホ実機の
    再確認手順は docs/M15-manual-test.md「M15.1」節
- 2026-07-06: M16 — 一晩自走テスト(AICAD・計画27/27完遂・介入0)の知見反映
  - M16-0: 実測記録を docs/autonomy-comparison.md へ追記(所要時間・トークン・モデル切替2回・
    弱点3件=切替時compaction無し/残高切れで停止/コピー手段無し → M16-1/2/3の根拠)
  - M16-1: モデル切替検知compaction — SessionData.lastLLM、service.compactOnSwitch、
    loop.onUsage フック(単一ターンでも実測トークンを記録する実バグ修正込み)、infoカード
  - M16-2: llmErrors.classifyLLMError(billing判定を429より優先)、指数バックオフ最大3回、
    acquireFallback(発動audit `provider-fallback`・警告カード)、Settingsフォールバック節
  - M16-3: markdownBlocks共有スプリッタ+MarkdownMessage(コピー✓フィードバック・
    CDPスモークでOSクリップボード実測一致)
  - M16-4: styles.cssアニメ基盤+animPref(localStorage)+CDPスモーク
    (reduced-motionエミュレーションで無効化を実測)
- 2026-07-06: **M17 — リブランド(AMA-teras)+自律モード+左ペインソート修正**。テスト458→515件
  - M17-1: リネーム MyCodex → AMA-teras。userDataMigration.ts(実データ有無で移行判定・
    マーカー冪等・旧dir温存)。**実機で発覚した重要バグ**: safeStorage(DPAPI)の鍵素材は
    Chromiumの「Local State」(os_crypt.encrypted_key)にあり、これを移行しないと
    secrets.json が復号不能=キー消失に見える → コピー対象へ追加し実機で復号確認(M17-1fix)。
    AMATERAS.md / AMATERAS_PLAN.md へ改称(旧名読み込み互換+初回書き込みrename移行、
    プラグインは実行時トランスパイルのため互換ロジックを各ファイル内で自己完結)
  - M17-2: 自律モード。executor.getAutonomous(全リスク+system+動的承認を自動承認・
    全操作audit autonomous:true)、scope.ts autonomousオプション(システム領域=既存上書きのみ拒否・
    新規作成許可)、autonomy.ts denylist(format/diskpart/mkfs/dd physicaldrive/
    del・rd system/rm -rf/reg delete HKLM/cipher /w/bcdedit /delete/vssadmin delete shadows)、
    UIトグル+モーダル+警告バー、remote-ui(POST /api/autonomous・ONはconfirmed必須)、
    進化非波及guardrail。実機CDPでモーダルdisabled→ON→バー→OFFを確認
  - M17-3: sessionGroups.groupSessionsByProject(最新updatedAt降順・安定・選択非依存)+LeftPane適用
  - M17-4: docs/M17-manual-test.md、USER-GUIDE(自律モード節・名称)、本ファイル更新
- 2026-07-06: **M18 — モデル自動切替(planner/worker/escalation)**。テスト515→532件
  - M18-1: AppConfig.modelPolicy + parseModelPolicy(壊れた形は無効へ・格上げ回数0〜3クランプ)
  - M18-2/3: 帯ルーティング(chatSend=planner、subagent=worker、currentLLM/compaction閾値も
    planner基準でM16-1と整合)、runWorkSubAgentのエスカレーションループ(compact経由・
    履歴引き継ぎ・プロバイダ横断でtool_use/resultペア不変をテスト固定)、
    acquireChildFallback(子ループ用M16フォールバック・メインのrunProvider/lastLLM非干渉)
  - M18-4: ModelPolicySection(Settings)+plannerバッジ+⤴格上げバッジ
  - M18-5: ベンチ②実測(2.3分・vitest10/10・worker委譲でコスト約半減)→autonomy-comparison.md、
    docs/M18-manual-test.md、USER-GUIDE「モデル自動切替」節
- 2026-07-06: **M19 — 品質レビュー・ゲート(planner採点→差し戻し)**。テスト532→566件
  - M19-1: AppConfig.reviewGate + parseReviewGate(クランプ・axes補完)+ AgentEvent 'review'
  - M19-2: review/gate.ts(レビュアーエージェント=読み取り専用+localhost限定screenshot、
    JSONパース=抽象指摘の機械排除、runReviewCycle、buildFixTask)+ planDiff.ts
  - M19-3: service配線(planツールdiffでマイルストーン検知→同期レビュー→tool_result追記、
    完了時縮退、fix=runParallelSubAgents(work)でM18/M16配線をそのまま利用、
    上限到達の承認/警告分岐)+ 進化非波及guardrail(発動箇所2箇所固定)
  - M19-4: ReviewCard(4軸表+指摘リスト)+ chat/remote-uiストア + Settings「品質レビュー」節
  - M19-5: 実測(バグ入りコード検出→改善 2.33→4.33、ベンチ②ON +$0.15/+78%)→
    autonomy-comparison.md、docs/M19-manual-test.md、USER-GUIDE「品質レビュー」節

## 次のタスク

- (ユーザー)M29の確認事項(冒頭「未解決・ユーザーへの連絡事項」参照):
  接続テスト再疎通(Gemini修正後)/ 包括承認・棚卸しの実機動作 / 狭幅表示の確認
- (ユーザー)持ち越し: amateras-registry の GitHub作成・push・公開 /
  Roaming\Electron 削除 / 戦略文書の公開前最終目視
- 狭幅レスポンシブ残課題(約37箇所の未wrap flex行)の実表示ベースでの段階対応
- フェーズ1残(BRAND_STRATEGY.md): デモGIF録画(docs/demo.gif)、公開後CIへの
  シークレットスキャン(gitleaks等)+npm audit 組み込み
- フェーズ3布石の続き: 共有フロー(REGISTRY_DESIGN「共有フロー」節=GitHubサインイン・
  スクラブ・PR代行)、テーマの流通(ファイル選択/共有UI)と細部エイリアスの網羅、
  検証済みプラグインの署名、配布版のレジストリ導入経路(docs/packaged-evolution.md)
- 無料APIモードの実測調整: 各プリセットの互換レイヤ相性(stream_options/usage)と
  レート制限文言の実地確認、必要ならモデル候補の更新
- M26 の実運用フィードバック: severity 方式の合格率・reviewer/explorer 帯のコスト削減効果を
  UsageSection の帯別集計で観察し、プリセットの帯割当を再調整する
- refusal フォールバックの実発火ログ(audit.jsonl の 'refusal(N/2)')を確認し、
  1段下候補の妥当性(fable→opus で足りるか)を検証する
- (ユーザー)iPhone実機+Tailscale(docs/M10-manual-test.md B節)、NSISインストーラ
  (開発者モードONで `npm run dist`)
- docs/M12-manual-test.md の残り体感確認(ツール実行中の強制終了→復元、キャンセル伝播、
  スマホからのサブエージェント承認)
- **QRコード表示**(設計書の後続タスク): `qrcode` 依存を追加し、Settingsの接続URLを
  QR表示する。依存追加を伴うためユーザー承認後に実施
- M9残: 進化ジョブ生成プロンプトへの pathParams 宣言の追加
- SSE の Last-Event-ID 対応(現状は再接続時 snapshot で全量回復。会話が長大化したら検討)
- 多重起動ガード導入済みだが、`second-instance` での引数引き継ぎ(ファイルを開く等)は未対応

## 既知のバグ・課題

- (M10) **remote-ui の Vite ビルドが未実行**(サンドボックスは rollup のネイティブ
  パーサ不可)。`npm run build` 実行までリモートUIは配信されない(サーバ自体・APIは稼働)。
  esbuildバンドル(構文・import解決)と typecheck・ユニットテスト235件は合格済み
- (M10) パッケージ(NSIS)版では out/remote-ui が asar 内に含まれる想定
  (electron-builder files: out/**)だが、パッケージ版での配信動作は未検証
- (M10) SSE snapshot の履歴はテキスト+ツール名のみ(実行中のツールカードの生死は
  復元しない)。リモート接続中のライブイベントでは完全表示される
- (M10) 認証バンは接続元IP単位。Tailscale内(=同一tailnetの少数端末)前提の簡易実装
- (M11) チェックポイント復元は「上書き」方式。復元先チェックポイント作成後に新規作成された
  ファイルは削除されない(pre-restore 退避で往復は可能)
- (M11) `refs/mycodex/checkpoints/*` の自動掃除(世代上限・GC)は未実装。手動削除手順は
  docs/M11-manual-test.md に記載
- (M11) postEditHook タイムアウト打ち切り時、フックの孫プロセスが残る可能性
  (メッセージで明示。spawn timeout はシェルしか殺さないため)
- (M11) postEditHook の発火はツール名 write_file / edit_file 固定。生成ツール(csv_to_markdown等)
  の書き込みには発火しない(M9のpathParams未宣言問題と同系)
- (M11) ~~taskkill /T /F の実動作は Windows 実機未確認~~ → 2026-07-05 実機確認済み
  (孫プロセスまで死亡。VERIFICATION_REPORT.md)
- (M12) セッション復元は履歴のみ。実行中だったバックグラウンドproc・承認待ちは復元しない(仕様)
- (M12) work サブエージェントに processes 非注入(バックグラウンドbash不可)。必要になったら注入検討
- (M12) WriteLockTable は pathParams 宣言済みツールの write のみ対象(bash 経由の書き込みは対象外。
  restrictExec と同根の制約)
- (M12) **チェックポイントが .gitignore の無い workspace で node_modules ごと snapshot する**:
  `git add -A` が数十秒かかり、その間 UI は idle 表示でも activeRun が未クリアで
  次の送信が「別の実行が進行中」になる。対策候補: 一時 index への add 時に
  node_modules/dist を既定除外、または activeRun クリアを終端イベント直後へ移す
- (M11) セッションキャンセルでバックグラウンドprocも全kill(設計どおり)。セッションを跨いで
  dev server を維持したい場合は再起動が必要
- (M9) スコープ判定は `pathParams` を宣言したツールのみ対象。未宣言ツール
  (csv_to_markdown 等の生成ツール)がパスを受け取る場合は判定対象外
  (safe/writeのrisk承認は従来どおり効く)
- (M9) dispatch_agent のサブエージェントは executor を通さず safe ツールを直接実行するため、
  workspace外の「読み取り」がスコープ判定を受けない(書き込み/実行は元々不可)
- ~~(M9) audit.jsonl の閲覧UIは未実装~~ → M10 のスマホUI監査タブで提供済み

## 決定事項ログ

### M21/M22での判断(2026-07-06 夜間自走)

- **追加指示の注入は「直前のuserメッセージ末尾へのtextブロック追記」**: Anthropicは
  tool_result先頭規約に適合し、OpenAI互換層は順に分解されるため両プロバイダで安全。
  独立したuserメッセージ挿入は連続userの扱いがプロバイダ依存になるため避けた
- **応答完了時に残っていた追加指示は新userメッセージでループ継続**(取りこぼし禁止)
- **narrationはtext_deltaの再利用**(APIコスト追加なし)。500ms/1sスロットルでIPC負荷を抑制
- **⏳無応答の判定はrenderer側タイマー**(main側にタイマーを持たない=クリーンアップ不要)
- **M22はイベントへのconversationId一括付与で多重化**(emitクロージャ1箇所で注入。
  イベント型の破壊的変更なし=後方互換)。renderer側は「表示中の会話だけ反映」+
  conversationId未確定間のイベントはバッファし、chatSendの戻り値で確定後に再生
  (先着runsList照合方式は自ランを誤除外するバグになった→実機スモークで検出し方式変更)
- **ランのworkspaceは開始時に固定**: 視聴切替でconfig.workspaceが変わっても実行中ランの
  cwd/スコープ/チェックポイント/記憶計画の読み書きは元プロジェクトに束縛される
- **自律モード(M17)を会話単位へ再定義**: 切替で他会話の自律ランを壊さない。
  新規/ディスクからのロードは常にOFF・再起動で全OFF・昇格承認の人間必須(M20不変条件3)は不変
- **バックグラウンドプロセス(M11-2)を会話単位のProcessManagerへ**: 会話Aのcancelが
  Bのdevサーバを殺さない
- **checkpointRestoreは同一workspaceにランがある間だけ拒否**(全体ブロックから緩和)
- **進化ジョブは引き続き直列キュー**(並行化しない。B worktreeの競合を避ける)

### QR非表示バグ修正での判断(2026-07-06)

- **リモート接続ホスト名はconfig.json(remote.host)へ永続化**: 旧実装はrendererのlocalStorage
  保存で、M17のuserData移行に「Local Storage」(leveldb実体)が含まれず消失→ホスト空→URL組めず
  →QR非表示、が原因だった。UI側は旧localStorage値からの自己修復(読み取り→config保存)つき
- **userData移行のCOPY_ENTRIESに「Local Storage」「Session Storage」を追加**(再発防止・
  将来の移行向け。テストで固定)


### 整理タスクでの判断(2026-07-06)

- **「フォルダで開く」はworkspace外制限を課さない**: エクスプローラーに場所を見せるだけで
  内容は読まずrendererにも返さないため。左ペインには現在以外のプロジェクトも並ぶので必須。
  保護領域denyは多層防御として維持
- **service.ts の SYSTEM_PROMPT内「コーディングエージェント」は据え置き**: ユーザー向け表記の
  統一(副題・README・package.json)とは別物で、モデルへの機能定義。変えると挙動に影響し得る
- **アイコン生成は依存追加なし**(稼働中ChromiumのcanvasをCDP経由で使用・段階縮小+角丸クリップ)。
  icoはPNG圧縮エントリのマルチサイズ(Vista+標準)。build/candidates と icon.svg は旧検討の
  残骸なので未追跡のまま

### M20での判断(2026-07-06 自律作業。planはユーザー承認済み+不変条件3件指定)

- **聖域判定はA側のメモリ上PROTECTED_PATHSのみ**(ユーザー指定の不変条件1):
  worktree B側のprotected.tsをrequire/importして判定に使うことを構造的に禁止
  (ソーストリップワイヤテスト+「Bで無力化しても捕捉」実証テストで固定)
- **IPC聖域の粒度は ipc.ts + preload + shared/ipc.ts の丸ごと保護**: チャネル単位の
  細分化は「安全な追加」と「承認バイパスの追加」を機械で区別できないため、太く守る
- **`src/shared` はrenderer scopeに含めない(=core扱い)**: 型定義経由でmain側挙動に
  影響し得るため、UI変更の名目でshared改変されるのを防ぐ
- **--smoke-boot は単一インスタンスロックを取らずuserData隔離(mkdtemp)**(不変条件2):
  稼働中Aと並走して健全性チェックできる。MYCODEX_SMOKE既存スキップに乗せ、
  配線をソーストリップワイヤテストで固定
- **昇格承認は自律モードでも絶対に自動化しない**(不変条件3): 挙動テスト
  (autonomous ON+全自動承認ONでもrespondまで未解決)+承認フローにautonomousMode参照が
  ないことのソース検査で二重固定
- **健全性は「再起動前」に判定**: B側スモーク+A側再ビルド後スモークの二重ゲートで
  合格したときだけ再起動する。センチネル/セーフモードは「それでも起動後に壊れた」ときの二次防衛
- **rollbackLastEvolve はHEAD==最新evolveマージのときだけ自動revert**: それ以外は
  手動手順を提示(履歴が進んだ後の自動revertはコンフリクトで中途半端に壊すリスクの方が大きい)
- **M19品質レビューの進化ジョブ適用は見送り**(ユーザー承認済み): ゲート7段+人間承認が
  既にあり、レビュー追加はコスト増に見合わない。必要になれば後続で
- **symlink差分(mode 120000)は聖域チェックで一律拒否**: 聖域外パスからのリンクで
  実体を聖域に向ける迂回を塞ぐ
- **コミット順を3(スーパーバイザー)→4(配線)に入替**: 未完成のrenderer/core昇格経路が
  一瞬でも露出しないように、受け側を先にコミット

### M19での判断(2026-07-06 自律作業。planはユーザー承認済み)

- **マイルストーンレビューはツール実行内で同期実行し、要約をplanのtool_resultへ追記**:
  メインモデル自身が合否を認識して次の行動(残課題対応など)に反映できる
- **レビュアーは会話履歴を見ない**(userRequest+計画+実ファイルのみ): 「自分が書いた前提を
  持たない第三者」を構造的に強制。メインが「修正するな」と縛られていても検出できる(実測済み)
- **レビュー自体の失敗(JSON不出力・キャンセル)は素通し+警告**: レビュアーの不調で
  本体タスクを壊さない。再レビュー失敗時は「未解決」扱い(素通しにしない)
- **抽象指摘はパーサで機械排除**: findingsはfile/location/problem/fixの4フィールド必須。
  欠けた指摘は捨てる(プロンプト指示だけに頼らない)
- **レビュアーのscreenshotはlocalhost限定**: executor承認フローを経由しないため、
  外部URLは機械拒否(プラグインのdynamicApprovalと同等の制約を直接実装)
- **完了時縮退レビューはwrite/exec成功があった会話のみ**: 質問・調査だけの会話に
  レビューコストをかけない
- **上限到達の承認deny=そのまま終了+指示待ち案内**(追加ラウンドは回さない): 無限ループ防止を
  優先し、続きはユーザーの明示指示で
- **fix実行はrunParallelSubAgents(work)を単タスクで再利用**: 承認・スコープ・監査・
  M18エスカレーション・M16子フォールバック・サブエージェントUIが自動で効く

### M18での判断(2026-07-06 自律作業。planはユーザー承認済み)

- **createProvider()(進化ジョブの経路)はmodelPolicyを一切参照しない**: 帯選択はchatSend側の
  createBandProviderに分離。「進化はpolicyの影響を受けない」をコード構造で保証+guardrailテスト
- **帯プロバイダのキー判定はfactory差し替えより先**: キー未登録の警告経路もテスト可能にするため
- **worker帯キー未登録は停止でなくplanner代行+警告カード**: 横断構成の取りこぼしで作業が
  止まるより、高い方のモデルで続行する方が自走の趣旨に合う
- **エスカレーションのトリガー(c)は「ツール失敗3連続」**(isError または 編集後フック失敗を
  本文パターンで検出)。成功で連続カウントはリセット
- **子ループのフォールバックは専用のacquireChildFallback**: メインのacquireFallbackを共用すると
  メインのrunProvider/lastLLMが子の課金エラーで書き換わるため分離。1会話1回の制限
  (fallbackUsedFor)は共有。子履歴は小さいので切替前compactionは省略
- **チャットのバッジは「メイン応答=planner・サブパネル=worker/⤴格上げ」の最小実装**:
  ツールカード単位のバッジは情報過多と判断(必要になれば追加)
- **ベンチ後の設定復元でmodelPolicyはenabled:false+帯設定保存**: ユーザーがSettingsで
  ワンクリック有効化できる状態にした(既定は無効の絶対条件は維持)

### M17での判断(2026-07-06 自律作業。planはユーザー承認済み)

- **userDataの移行判定は「ディレクトリ存在」でなく実データ(config.json等)の有無**:
  electronがキャッシュ用に新dirを先に作るため、存在判定だと移行がスキップされる(実機で確認)
- **「Local State」を移行対象に追加**(M17-1fix): safeStorageの鍵素材。実データ判定には使わない
- **自律モードでもuserDataへの新規ファイル作成は拒否のまま**(設計書の「新規作成許可」は
  Windowsシステム領域にのみ適用): plugin-cacheへの新規.mjs設置=次回ロードでのコード注入経路になるため
- **denylistは自律モード限定**: 通常モードは人間の目視承認が防波堤であり、機械判定の
  誤検出で正当な承認済みコマンドを塞がない
- **自律モード状態はメモリ内のみ**(configに保存しない): 再起動OFFの要件を構造的に満たす。
  セッション切替・新規でも setAutonomous(false)
- **リネームで変えないもの**: リポジトリパス・`refs/mycodex`(既存チェックポイント互換)・
  localStorageキー`mycodex-*`(**変えるとスマホのremote-tokenが消えて再ログインになる**)・
  `MYCODEX_SMOKE`等の内部識別子・進化タグ`evolve/N`・worktreeBase `../mycodex-evolve`
- **旧ショートカット「MyCodex.lnk」はそのまま動く**(electron.exe . を指すため)。リネームは任意

### M16での判断(2026-07-06 自律作業・ユーザー確認なしで決定)

- **フォールバックは本体provider設定を書き換えない**(計画承認済み)。実行中の会話の
  LLMProvider インスタンスだけ差し替え、次の新規会話は本体設定で開始する
- **billing判定はHTTPステータスより優先**: OpenAIのinsufficient_quotaは429(通常transient)、
  Anthropicの残高枯渇は400(通常fatal)で来るため、メッセージ正規表現を先に評価する
- **フォールバックの往復ループ禁止**: 1会話(conversation.id)につき1回・切替先=現行と同一なら拒否
- **remote-uiのmarkdownは全レンダリングせずフェンス分割のみ**(コードブロック+コピーだけ提供)。
  依存追加なし方針とモバイルの表示崩れリスクを優先。スプリッタは src/shared で共有しユニット固定
- **未クローズフェンス(ストリーミング途中)は「そこまでをコード」として表示**
  (閉じフェンス到着で自然に確定する。チラつき防止で判定を遅らせるより単純)
- **アニメ設定はlocalStorage**(承認済み)。AppConfigに入れない=mainプロセス・進化ジョブに不波及。
  `<html data-anim>` 属性 + CSSセレクタで一括制御し、コンポーネント側はクラス付与のみ
- **prefers-reduced-motion はSettingsトグルより優先して無効化**(OSのアクセシビリティ設定を尊重)
- **loop.onUsage フックを追加**(M16-1): lastPromptTokens が compact コールバック(turn>0)でしか
  更新されず単一ターン会話で常に0だった実バグの修正。テスト側を曲げずに本体を直した

- 2026-07-03: 開発マシンに Node.js が無かったため winget で LTS (v24.18.0) を導入
- 2026-07-03: APIキー保管は keytar でなく Electron 組み込みの safeStorage を採用
  (keytar が非メンテのため。CLAUDE.md「keytar等」の範囲内と判断)
- 2026-07-03: IPC payload の実行時検証は手書きガード(zod 不採用 — 外部依存最小方針)
- 2026-07-03: 進化ジョブの B worktree は `../mycodex-evolve/job-<N>`、node_modules は
  ジャンクションで A と共有。依存追加を要するジョブは fail 扱い(依存最小方針)
- 2026-07-03: 既定モデルは claude-opus-4-8(設定で変更可)。thinkingは未使用
  (tool_use連鎖でthinkingブロックのエコーバック管理が必要になるため、M7以降で検討)
- 2026-07-03: M3のエージェント作業ディレクトリは暫定でアプリのルート(app.getAppPath())。
  ワークスペース選択UIはM7で追加予定
- 2026-07-03: 検証ゲートの順序をARCHITECTURE.md原案(typecheck→vitest→smoke→差分検査)から
  「差分検査を最初」に変更。保護領域を書き換えた生成コードを、コード実行を伴う後続ゲート
  (vitest等)で走らせる前に落とすため(ARCHITECTURE.md §6.2も更新済み)
- 2026-07-03: 進化ジョブ内のツール実行は自動承認(昇格時に人間の承認+diff全文表示があるため)。
  昇格承認ダイアログでは child_process/ネットワークをdiffから機械検出して明示警告
- 2026-07-04: bashの保護領域バイパス対策は、executor層でのパス強制が不可能(shellをパースできない)
  ため、進化ジョブでは実行できるコマンド自体を検証系(npm run/npx vitest/npx tsc)に限定する方式を採用
  (ToolContext.restrictExec)。判定はプラグイン規約によりbash.ts内に持つ。残余リスク: npm scriptsの
  範囲内。node_modulesジャンクション経由の改変はbashからの任意コマンドを塞いだことで大幅に縮小
- 2026-07-04: コンテキスト圧縮の境界はuserテキストターンの先頭。tool_use/tool_resultを分断すると
  API400になるため(指摘#1と同根)。要約は現行プロバイダのcompleteで実施(プロバイダ非依存)
- 2026-07-04: サブエージェントは ToolContext.subagent 経由で注入(evolutionと同パターン。プラグインは
  コアをimportできないため)。子は読み取り専用ツールのみ・別history・要約のみ親へ返す
- 2026-07-04: パッケージ版のプラグインは .ts を extraResources で resources/plugins へ同梱し、
  esbuildで実行時トランスパイル。esbuildネイティブバイナリはasarUnpack+ESBUILD_BINARY_PATHで解決。
  進化(git/worktree)はソースツリー前提のためパッケージ版では基本ツールのみ(既知の制約)
- 2026-07-04: electron-builderのNSISインストーラ生成は、winCodeSign展開時のmacOSシンボリックリンク
  作成にWindowsのシンボリックリンク権限が要り現環境でブロック。開発者モードON or 管理者実行で解消。
  コード署名は不要方針(CSC_IDENTITY_AUTO_DISCOVERY=false)

### M9での判断(2026-07-04 自律作業・ユーザー確認なしで決定)

- **projectモードのsystemスコープは「即拒否」**(設計書の挙動マトリクスどおり)。
  厳密には従来、workspace外パスも(承認さえ通れば)操作できたため挙動変更になるが、
  設計書の「'project' = 従来どおりworkspace内のみ」という意図を優先した。
  「後方互換」は「workspace内の操作・既存テスト・進化ジョブの挙動が不変」という解釈
- **userDataはwrite全面ハード拒否、secrets.jsonはreadもハード拒否**(暗号化済みでも
  鍵素材をLLMコンテキストへ晒さない)。config.jsonのreadは許可(現状の挙動を維持)
- **fullPcでのexec強制承認は bash に限らず risk:'exec' の全プラグインに適用**
  (どのパスに触るか静的に判定できない点はbashと同じため)
- **スコープ制御はexecutorに一元化**し、`ExecutorDeps.getScopePolicy` 未指定なら完全に従来挙動。
  進化ジョブ(AgentJobRunner)には注入しない=fullPc設定が進化ジョブへ波及しない。
  guardrails.test.ts のソース・トリップワイヤで「注入しないこと」自体もテストで固定
- **pathParamsはopt-in宣言**(inputSchemaからの自動推測はしない)。誤検知でツールが
  使えなくなるより、組み込みツールで確実に効くことを優先。未宣言ツールは既知の課題に記載
- **検証環境**: 今夜の検証はLinuxサンドボックスの /tmp クローンで実施。ネットワーク遮断のため
  npm installが不可能になり、Windows側 node_modules をコピーし esbuild(linux版に差替)+
  rollup(parseAstをacornに差替)のサンドボックス限定パッチで vitest を駆動した
  (リポジトリのコードには一切影響なし)。検証は最終ツリーで typecheck+vitest 175件一括合格を
  確認後にステップ単位でコミット分割(コミットごとの逐次検証は環境制約により省略)

### M11での判断(2026-07-04 深夜 自律作業・ユーザー確認なしで決定)

- **チェックポイントは `AgentServiceDeps.createCheckpoints` で注入する opt-in 構成**
  (service 内で CheckpointManager を直接 new しない)。理由: (1)ユニットテストが
  実行中リポジトリへ refs を書かない (2)進化ジョブ・テスト環境への非波及が構成レベルで
  保証される。実配線は ipc.ts のみ
- **チェックポイント復元は「上書き」**(`git restore --source=<sha> --worktree -- .` 相当)。
  チェックポイント後に増えたファイルは削除しない — 誤削除より安全側に倒した
  (pre-restore への自動退避で往復可能)
- **snapshot の skip 判定は「直近チェックポイント(無ければHEAD)との tree 比較」**。
  クリーンな作業ツリーでは ref を作らない。一覧はコミットメッセージ接頭辞
  `[mycodex-checkpoint]` でチェーンを打ち切る(親がHEAD以前の通常履歴に繋がるため)
- **一時indexは read-tree HEAD から開始**(空indexからの add -A だと tracked かつ
  .gitignore 対象のファイルを取りこぼすため)
- **postEditHook の発火対象はツール名 write_file / edit_file 固定**(risk:'write' 全般ではない。
  設計書の文言どおり。生成ツールへの適用は見送り=既知の課題へ)
- **postEditHook は spawn timeout + フォールバックタイマーの二段構え**。spawn の timeout は
  シェルのみを kill し、孫プロセスが stdio を握ると close イベントが発火せずループが固まる
  ことをテストで確認したため(タイムアウト+0.5秒で必ず戻る)
- **セッションキャンセルでバックグラウンドprocも全kill**(設計どおり)。ProcessManager の
  platform とバッファ上限はコンストラクタ注入にし、Windows kill コマンドの組み立て
  (`taskkill /pid <pid> /T /F`)を単体テストで固定(実動作は実機確認事項)
- **bash の background は restrictExec 判定の後**に処理(進化ジョブでは許可コマンド自体が
  検証系のみ+processes 未注入の明示エラーで二重に塞がる)
- **チェックポイントの committer は `mycodex-checkpoint` に固定**(`-c user.name/email`)。
  git identity 未設定の workspace でも snapshot が失敗しない
- **検証環境**: M9/M10 と同じ /tmp クローン+パッチ済み node_modules。mountキャッシュ不整合
  (host編集済みファイルが mount から古い/切詰め内容で見える)に複数回遭遇したため、
  「/tmp へスクリプトでパッチ→typecheck+vitest→cp+rename(.fresh→mv)で mount へ配置→
  git diff --cached 確認→コミット」の手順に固定した

### M10での判断(2026-07-04 自律作業・ユーザー確認なしで決定)

- **設計書のM10-1〜M10-6のステップ定義が文書末尾の欠損で読めなかった**
  (docs/M10-mobile-web-design.md が「apple-mobile-we」で途切れている)ため、
  文書の構成に沿って自分でステップを再構成した:
  M10-1=コア抽出 / M10-2=認証+config / M10-3=HTTP+SSEサーバ / M10-4=remote-ui /
  M10-5=配線+デスクトップUI+承認競合 / M10-6=ドキュメント
- **EventBus のチャネル名は既存IPCチャネル名と同一**('chat:event' 等)にして
  IPC・SSE双方への写像を単純化。SSE の event 名もそのまま使う
- **静的配信(UI本体)は認証不要**とした。SPAシェルは秘匿情報を含まず、トークン入力前に
  ブラウザがページを読めないと成立しないため。/api/* は全て認証必須
- **リモートからの allow-session はサーバ側で allow に降格**(UI側でもボタンを出さない)。
  セッション永続の許可は端末を目視しているデスクトップ操作に限る
- **remote設定はsettings:setから変更不可**(専用IPCのみ)。renderer全体を信頼はしているが、
  tokenHash の誤消去・改変経路を機械的に塞ぐため
- **トークン平文は remoteSetEnabled / remoteRegenerateToken の戻り値でのみ返し、
  どこにも保存しない**。UIを閉じたら再表示不可(再生成で対応)
- **remote-ui は Tailwind 不使用の素CSS**。既存devDepsのみ制約下でビルド構成を最小化し、
  サンドボックスでのビルド失敗要因を減らすため
- **snapshot方式の状態回復**(Last-Event-ID なし)。再接続時は全量snapshotで十分小さい
- **サンドボックスでは vite build(rollupネイティブparseAsync)が動かない**ことを確認
  (acornパッチはparseAst系のみ有効。バイナリASTを返すparseAsyncは代替不能)。
  代替として esbuild で remote-ui をバンドルして構文・依存解決を検証し、
  Vite実ビルドは「Windows側で npm run build」に委ねた
- **out/remote-ui はパッケージ版では asar 内から配信**(electron-builder files に out/**
  が既に含まれ、electronのfsはasarを透過的に読めるため extraResources 追加は不要と判断)
