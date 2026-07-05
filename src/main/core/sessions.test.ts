import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, LLMProvider, ProviderEvent } from '../providers/types';
import {
  foldHistoryIfOversize,
  historyJsonBytes,
  INTERRUPTED_RESULT_TEXT,
  repairDanglingToolUse,
  SESSION_SCHEMA_VERSION,
  SessionStore,
  type SessionData,
} from './sessions';

const ID1 = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';

function makeData(overrides?: Partial<SessionData>): SessionData {
  return {
    version: SESSION_SCHEMA_VERSION,
    id: ID1,
    title: 'テストセッション',
    workspace: 'C:\\ws',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:01:00.000Z',
    history: [
      { role: 'user', content: [{ type: 'text', text: 'こんにちは' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'やあ' }] },
    ],
    ...overrides,
  };
}

function summaryProvider(summary: string): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text: summary }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-sessions-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('SessionStore(M12-1)', () => {
  it('save→load で履歴・メタが同一に戻り、一覧に載る', async () => {
    const store = new SessionStore(dir);
    const data = makeData();
    await store.save(data);
    const loaded = await store.load(ID1);
    expect(loaded).toEqual(data);

    const list = await store.list();
    expect(list).toEqual([
      {
        id: ID1,
        title: 'テストセッション',
        workspace: 'C:\\ws',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: 2,
      },
    ]);
  });

  it('アトミック書き込み: 保存後に .tmp が残らない', async () => {
    const store = new SessionStore(dir);
    await store.save(makeData());
    await store.save(makeData({ updatedAt: '2026-07-05T00:02:00.000Z' }));
    const files = await readdir(dir);
    expect(files).toEqual([`${ID1}.json`]);
  });

  it('保存されるトップレベルキーは既知のもののみ(secrets等が紛れ込まない)', async () => {
    const store = new SessionStore(dir);
    await store.save(makeData());
    const parsed = JSON.parse(await readFile(join(dir, `${ID1}.json`), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['createdAt', 'history', 'id', 'title', 'updatedAt', 'version', 'workspace'].sort(),
    );
  });

  it('未知バージョン・壊れたJSONは load で null', async () => {
    const store = new SessionStore(dir);
    await store.save(makeData());
    await writeFile(join(dir, `${ID2}.json`), JSON.stringify({ ...makeData({ id: ID2 }), version: 999 }));
    expect(await store.load(ID2)).toBeNull();
    await writeFile(join(dir, `${ID2}.json`), '{broken json');
    expect(await store.load(ID2)).toBeNull();
    // 壊れたファイルは一覧からも除外される
    expect((await store.list()).map((m) => m.id)).toEqual([ID1]);
  });

  it('不正なID(パストラバーサル)は load/delete が無害に振る舞い、save は拒否する', async () => {
    const store = new SessionStore(dir);
    expect(await store.load('..\\..\\evil')).toBeNull();
    await store.delete('../evil'); // 例外にならず noop
    await expect(store.save(makeData({ id: '../evil' }))).rejects.toThrow('不正なセッションID');
  });

  it('一覧は updatedAt 降順', async () => {
    const store = new SessionStore(dir);
    await store.save(makeData({ id: ID1, updatedAt: '2026-07-05T00:01:00.000Z' }));
    await store.save(makeData({ id: ID2, updatedAt: '2026-07-05T09:00:00.000Z' }));
    expect((await store.list()).map((m) => m.id)).toEqual([ID2, ID1]);
  });

  it('delete でファイルが消える', async () => {
    const store = new SessionStore(dir);
    await store.save(makeData());
    await store.delete(ID1);
    expect(await store.load(ID1)).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});

describe('M15-2: search / rename', () => {
  it('タイトル・本文の部分一致で検索できる(大文字小文字非依存)', async () => {
    const store = new SessionStore(dir);
    await store.save(makeData({ id: ID1, title: 'React計画' }));
    await store.save(
      makeData({
        id: ID2,
        title: '別件',
        history: [{ role: 'user', content: [{ type: 'text', text: 'Express APIを作って' }] }],
      }),
    );
    expect((await store.search('react')).map((m) => m.id)).toEqual([ID1]);
    expect((await store.search('EXPRESS')).map((m) => m.id)).toEqual([ID2]);
    expect(await store.search('存在しない語')).toEqual([]);
    expect((await store.search('  ')).length).toBe(2); // 空クエリは全件
  });

  it('rename でタイトルと updatedAt が更新される。不正は false', async () => {
    const store = new SessionStore(dir);
    await store.save(makeData({ updatedAt: '2026-07-05T00:00:00.000Z' }));
    expect(await store.rename(ID1, '  新しい名前  ')).toBe(true);
    const meta = (await store.list())[0]!;
    expect(meta.title).toBe('新しい名前');
    expect(meta.updatedAt > '2026-07-05T00:00:00.000Z').toBe(true);
    // 履歴は無傷
    expect((await store.load(ID1))!.history).toHaveLength(2);

    expect(await store.rename(ID1, '   ')).toBe(false);
    expect(await store.rename('../evil', 'x')).toBe(false);
    expect(await store.rename(ID2, 'x')).toBe(false); // 存在しない
  });
});

describe('repairDanglingToolUse(中断復元)', () => {
  it('末尾 assistant の tool_use に tool_result が無ければ合成 user メッセージで閉じる', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'ファイルを書いて' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'write_file', input: {} }],
      },
    ];
    const repaired = repairDanglingToolUse(history);
    expect(repaired).toBe(1);
    expect(history).toHaveLength(3);
    expect(history[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'tu-1', content: INTERRUPTED_RESULT_TEXT, isError: true },
      ],
    });
  });

  it('一部の tool_result だけ欠けている場合は既存の user メッセージへ合成分を追記する', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '2つ実行して' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'read_file', input: {} },
          { type: 'tool_use', id: 'tu-2', name: 'grep', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu-1', content: 'ok' }] },
    ];
    const repaired = repairDanglingToolUse(history);
    expect(repaired).toBe(1);
    expect(history).toHaveLength(3);
    const results = history[2]!.content.filter((b) => b.type === 'tool_result');
    expect(results.map((b) => (b.type === 'tool_result' ? b.toolUseId : ''))).toEqual(['tu-1', 'tu-2']);
  });

  it('整合した履歴には手を付けない', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'grep', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu-1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: '完了' }] },
    ];
    const before = structuredClone(history);
    expect(repairDanglingToolUse(history)).toBe(0);
    expect(history).toEqual(before);
  });

  it('load 時に自動で修復される', async () => {
    const store = new SessionStore(dir);
    await store.save(
      makeData({
        history: [
          { role: 'user', content: [{ type: 'text', text: 'x' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-9', name: 'bash', input: {} }] },
        ],
      }),
    );
    const loaded = await store.load(ID1);
    expect(loaded!.history).toHaveLength(3);
    expect(loaded!.history[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu-9',
      isError: true,
    });
  });
});

describe('foldHistoryIfOversize(サイズ上限)', () => {
  function bigHistory(): ChatMessage[] {
    // 6ターン: 先頭2ターンが大きい(要約対象)、直近4ターンは小さい(保持される)
    const history: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      const text = i < 2 ? `大きい本文${'あ'.repeat(2000)}` : `小さい質問${i}`;
      history.push({ role: 'user', content: [{ type: 'text', text }] });
      history.push({ role: 'assistant', content: [{ type: 'text', text: `回答${i}` }] });
    }
    return history;
  }

  it('上限超過時は古いターンが要約に畳まれ、サイズが縮む', async () => {
    const history = bigHistory();
    const before = historyJsonBytes(history);
    const folded = await foldHistoryIfOversize(summaryProvider('これまでの要約'), history, 1024);
    expect(folded).toBe(true);
    expect(historyJsonBytes(history)).toBeLessThan(before);
    const first = history[0]!.content[0];
    expect(first!.type === 'text' && first!.text.includes('これまでの会話の要約')).toBe(true);
  });

  it('上限以内なら何もしない', async () => {
    const history = bigHistory();
    const before = structuredClone(history);
    const folded = await foldHistoryIfOversize(
      summaryProvider('未使用'),
      history,
      historyJsonBytes(history) + 1,
    );
    expect(folded).toBe(false);
    expect(history).toEqual(before);
  });
});
