/**
 * M16-3: HTTP(非secure context)では navigator.clipboard が**存在しない**ので
 * execCommand へフォールバックする。スマホのリモートUIは http://<host>:8787 で
 * 開くため、これが常態。
 *
 * M99-10: OpsView がこのヘルパーを使わず navigator.clipboard を直に触っていたため、
 * `undefined.writeText` の同期例外で **X投稿画面が開かなくなった**(実機でユーザー報告。
 * 例外が window.open より前で起きるので、コピーどころか遷移ごと死んでいた)。
 * クリップボードに触るときは必ずここを通すこと。
 *
 * 注意: async だが、非HTTPSでは最初の await の手前(execCommand経路)まで同期で走り切る。
 * そのため「void copyText(x); window.open(...)」の順で呼べば、window.open は
 * タップと同じ同期処理内に留まり、ポップアップブロックに塞がれない。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fallthrough */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
