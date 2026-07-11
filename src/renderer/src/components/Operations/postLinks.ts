/**
 * M32-9: 発信ドラフトの「1タップ投稿リンク」(AMENO-uzume追補)。
 * リンクを開いた先で最後のクリックをするのは人間 — 自動投稿は引き続き実装しない
 * (岩戸の掟: Xへの自動投稿は規約違反。Web Intentは公式のセミオート導線)。
 *
 * M39: 実体は shared/operations.ts へ移した(神議(main)も同じリンクを組み立てるため、
 * URL組み立てと正規表現を2箇所に置かない)。ここは renderer 向けの再エクスポート
 */
export { firstUrl, hatenaPanelUrl, xIntentUrl } from '../../../../shared/operations';
