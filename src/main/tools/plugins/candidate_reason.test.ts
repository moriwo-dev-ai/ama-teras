import { describe, expect, it } from 'vitest';
import candidateReason, {
  DEFAULT_KEYWORDS,
  buildReasonNote,
  excerptAround,
  findKeywordMatches,
  findRiskFlags,
  fitNoteLength,
} from './candidate_reason';
import type { ToolContext } from '../types';

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} };
}

const base = {
  account: '@sample',
  profile: 'AIと自動化が好き。AMA-terasを応援しています。',
  posts: ['今日のAMA-terasアップデートが公開された', '珈琲がおいしい'],
};

describe('findKeywordMatches', () => {
  it('プロフィールと投稿から一致した関連語と根拠抜粋を返す', () => {
    const matches = findKeywordMatches(
      [
        { where: 'プロフィール', text: 'AIと自動化が好き。AMA-terasを応援中。' },
        { where: '投稿1', text: '今日のamaterasアプデがすごい' },
      ],
      ['AMA-teras', 'amateras'],
    );
    expect(matches).toHaveLength(2);
    const inProfile = matches.find((m) => m.keyword === 'AMA-teras');
    expect(inProfile?.where).toBe('プロフィール');
    expect(inProfile?.excerpt).toContain('AMA-teras');
    const inPost = matches.find((m) => m.keyword === 'amateras');
    expect(inPost?.where).toBe('投稿1');
  });

  it('大文字小文字を無視して一致し、空語はスキップする', () => {
    const matches = findKeywordMatches([{ where: '投稿1', text: 'AMATERASは面白い' }], ['', 'amateras']);
    expect(matches).toHaveLength(1);
  });

  it('一致しない語は結果に含まれない', () => {
    expect(findKeywordMatches([{ where: '投稿1', text: '猫の写真' }], ['AMA-teras'])).toHaveLength(0);
  });
});

describe('findRiskFlags(接触注意の兆候)', () => {
  it('清浄なテキストでは空', () => {
    expect(findRiskFlags(['技術の話をしています'])).toEqual([]);
  });

  it('営業・勧誘と金銭・投資話を検出する', () => {
    const flags = findRiskFlags(['副業で稼げます！DMください']);
    expect(flags).toContain('営業・勧誘');
    expect(flags).toContain('金銭・投資話');
  });

  it('フォロー稼ぎと外部誘導を検出する', () => {
    const flags = findRiskFlags(['相互フォロー募集！LINE追加してね']);
    expect(flags).toContain('フォロー稼ぎ');
    expect(flags).toContain('外部誘導');
  });
});

describe('excerptAround', () => {
  it('長文では前後を…で囲み語の周辺を返す', () => {
    const ex = excerptAround(`${'あ'.repeat(40)}TARGET${'い'.repeat(40)}`, 40, 6);
    expect(ex).toContain('TARGET');
    expect(ex.startsWith('…')).toBe(true);
    expect(ex.endsWith('…')).toBe(true);
  });

  it('短文では省略記号が付かない', () => {
    expect(excerptAround('短いAMA-teras文', 2, 9)).toBe('短いAMA-teras文');
  });
});

describe('fitNoteLength', () => {
  it('長すぎる注記は文境界で切って maxLen 以下にする', () => {
    const fitted = fitNoteLength(`${'あ'.repeat(120)}。${'い'.repeat(120)}。`, 100, 200, []);
    expect(fitted.length).toBeLessThanOrEqual(200);
    expect(fitted.endsWith('。')).toBe(true);
  });

  it('短すぎる注記は補足文で minLen 以上にする', () => {
    const fitted = fitNoteLength('短い注記。', 100, 200, ['補足文を足して長さを確保する。']);
    expect(fitted.length).toBeGreaterThanOrEqual(100);
  });
});

describe('buildReasonNote', () => {
  it('既定の関連語はAMA-teras系', () => {
    expect(DEFAULT_KEYWORDS).toContain('AMA-teras');
  });

  it('関連語の一致と根拠を含む100〜200字の注記を生成し contact_ok になる', () => {
    const r = buildReasonNote(base);
    expect(r.note.length).toBeGreaterThanOrEqual(100);
    expect(r.note.length).toBeLessThanOrEqual(200);
    expect(r.note).toContain('AMA-teras');
    expect(r.recommendation).toBe('contact_ok');
    expect(r.riskFlags).toEqual([]);
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it('要注意の兆候があると caution になり注記に接触注意が入る', () => {
    const r = buildReasonNote({ ...base, posts: ['副業で稼げる話があります。DMください', ...base.posts] });
    expect(r.recommendation).toBe('caution');
    expect(r.riskFlags.length).toBeGreaterThan(0);
    expect(r.note).toContain('接触注意');
    expect(r.note.length).toBeLessThanOrEqual(200);
  });

  it('関連語が一致しなければ weak_relation になる(稀疏な入力でも100字以上に整える)', () => {
    const r = buildReasonNote({ account: '@neko', posts: ['猫の写真を撮った'] });
    expect(r.recommendation).toBe('weak_relation');
    expect(r.note.length).toBeGreaterThanOrEqual(100);
  });

  it('keywords 指定時は既定語ではなく指定語で探す', () => {
    const r = buildReasonNote({ account: '@x', posts: ['LLMの議論をした'], keywords: ['LLM'] });
    expect(r.matches).toHaveLength(1);
    expect(r.recommendation).toBe('contact_ok');
  });
});

describe('candidate_reason.execute', () => {
  it('候補情報から注記と内訳を返す', async () => {
    const r = await candidateReason.execute(base, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('候補 @sample の発見理由');
    expect(r.content).toContain('AMA-teras');
    expect(r.content).toContain('接触注意の兆候: なし');
    expect(r.content).toContain('接触候補として妥当');
  });

  it('兆候がある候補には接触注意の内訳が入る', async () => {
    const r = await candidateReason.execute(
      { account: '@spammy', posts: ['相互フォローと副業の案内です'] },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('接触注意の兆候: ');
    expect(r.content).toContain('慎重');
  });

  it('account が無い/不正ならエラー', async () => {
    expect((await candidateReason.execute({}, ctx())).isError).toBe(true);
    expect((await candidateReason.execute({ account: 42 }, ctx())).isError).toBe(true);
    expect((await candidateReason.execute({ account: '  ' }, ctx())).isError).toBe(true);
  });

  it('posts/keywords が文字列配列でなければエラー', async () => {
    expect((await candidateReason.execute({ account: '@a', posts: ['ok', 3] }, ctx())).isError).toBe(true);
    expect((await candidateReason.execute({ account: '@a', keywords: 'AI' }, ctx())).isError).toBe(true);
  });
});
