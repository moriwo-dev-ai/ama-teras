import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore } from './amenoUzume';

/**
 * M78: **真実を書いても、次の読み込みが上書きしていた。**
 *
 * M57は「Zenn記事とGitHub Releaseはアプリからは公開できない(人間が別途ボタンを押す)」
 * という前提で、zenn/github の下書きが posted なら読み込みのたびに staged へ倒していた。
 * その前提は M73(Zennの公開をアプリから)と M76(Zennの公開APIに実際に読めるか聞く)で
 * 消えたのに、変換だけが残った。結果:
 * - M76が「公開された」と posted を書く
 * - 次の list() が問答無用で staged へ巻き戻す
 * - 神議は**公開済みの記事**を「公開待ち4本」として数え続け、公開を催促し続けた
 *
 * 下書きの状態は憶測で倒さない。公開されたかどうかはZennに聞けば分かる。
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm78-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('M78: 下書きの状態を、読み込みのたびに書き換えない', () => {
  it('公開済み(posted)にしたZenn下書きは、読み直しても posted のまま', () => {
    const store = new DraftStore(dir);
    const [draft] = store.add([{ kind: 'article-outline', title: '記事', body: '## 章', media: 'zenn' }]);

    store.update(draft!.id, { status: 'posted' });

    // 実機ではここで staged へ巻き戻り、神議が延々と公開を催促していた
    expect(store.list().find((d) => d.id === draft!.id)?.status).toBe('posted');
    // 何度読んでも変わらない(list() は事実を書き換えない)
    expect(store.list().find((d) => d.id === draft!.id)?.status).toBe('posted');
  });

  it('GitHub Release の下書きも同じ(publishまで進んだものを公開待ちへ戻さない)', () => {
    const store = new DraftStore(dir);
    const [draft] = store.add([{ kind: 'release-note', title: 'v1.2.0', body: 'notes', media: 'github' }]);

    store.update(draft!.id, { status: 'posted' });

    expect(store.list().find((d) => d.id === draft!.id)?.status).toBe('posted');
  });
});
