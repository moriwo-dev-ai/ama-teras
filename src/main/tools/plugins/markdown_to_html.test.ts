import { describe, expect, it } from 'vitest';
import markdownToHtml from './markdown_to_html';
import type { ToolContext } from '../types';

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    log: () => {},
  };
}

async function run(markdown: string): Promise<string> {
  const r = await markdownToHtml.execute({ markdown }, ctx());
  expect(r.isError).toBeUndefined();
  const parsed: unknown = JSON.parse(r.content);
  if (parsed === null || typeof parsed !== 'object') throw new Error('JSONオブジェクトでない');
  const html = (parsed as { [key: string]: unknown }).html;
  if (typeof html !== 'string') throw new Error('html が文字列でない');
  return html;
}

describe('markdown_to_html(Markdown→最小HTML変換)', () => {
  it('見出し #〜###### を h1〜h6 へ変換する', async () => {
    const html = await run('# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六');
    expect(html).toContain('<h1>一</h1>');
    expect(html).toContain('<h2>二</h2>');
    expect(html).toContain('<h3>三</h3>');
    expect(html).toContain('<h4>四</h4>');
    expect(html).toContain('<h5>五</h5>');
    expect(html).toContain('<h6>六</h6>');
  });

  it('####### (7個) は見出しにならず段落になる', async () => {
    const html = await run('####### 七');
    expect(html).not.toContain('<h7>');
    expect(html).toContain('<p>');
  });

  it('太字・斜体・インラインコード・リンクを変換する', async () => {
    const html = await run('**bold** and *ital* and `code` and [site](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>ital</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com">site</a>');
  });

  it('太字と斜体が混在しても ** を先に処理する', async () => {
    const html = await run('**strong** *em*');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).not.toContain('<em><em>');
  });

  it('インラインコード内では太字・リンク記法を適用しない', async () => {
    const html = await run('use `**not bold** [x](y)` here');
    expect(html).toContain('<code>**not bold** [x](y)</code>');
    expect(html).not.toContain('<code><strong>');
  });

  it('順序なしリスト(-)を ul/li へ変換する', async () => {
    const html = await run('- りんご\n- みかん\n- ぶどう');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>りんご</li>');
    expect(html).toContain('<li>ぶどう</li>');
    expect(html).toContain('</ul>');
    expect(html).not.toContain('<ol>');
  });

  it('順序付きリスト(1.)を ol/li へ変換する', async () => {
    const html = await run('1. 手順一\n2. 手順二');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>手順一</li>');
    expect(html).toContain('<li>手順二</li>');
    expect(html).toContain('</ol>');
    expect(html).not.toContain('<ul>');
  });

  it('コードブロック(```)を pre/code へ変換し、中身は装飾しない', async () => {
    const html = await run('```\nconst x = 1;\n**not bold**\n```');
    expect(html).toContain('<pre><code>const x = 1;\n**not bold**</code></pre>');
    expect(html).not.toContain('<strong>');
  });

  it('コードブロック内の & < > をエスケープする', async () => {
    const html = await run('```\nif (a < b && c > d) {}\n```');
    expect(html).toContain('a &lt; b &amp;&amp; c &gt; d');
    expect(html).not.toContain('a < b');
  });

  it('閉じフェンスが無いコードブロックもEOFまでとして許容する', async () => {
    const html = await run('```\nabc');
    expect(html).toContain('<pre><code>abc</code></pre>');
  });

  it('段落: 空行区切りで p を分け、連続行は1つの p に連結する', async () => {
    const html = await run('一行目\n二行目\n\n次の段落');
    expect(html).toContain('<p>一行目 二行目</p>');
    expect(html).toContain('<p>次の段落</p>');
  });

  it('段落内の & < > " をエスケープする', async () => {
    const html = await run('a < b & c > d "quoted"');
    expect(html).toContain('&lt; b &amp; c &gt; d &quot;quoted&quot;');
    expect(html).not.toContain('a < b');
  });

  it('見出し内のインライン装飾も処理する', async () => {
    const html = await run('## **重要** な話');
    expect(html).toContain('<h2><strong>重要</strong> な話</h2>');
  });

  it('リスト項目内のインライン装飾も処理する', async () => {
    const html = await run('- `code` 付き\n- [link](https://x.example)');
    expect(html).toContain('<li><code>code</code> 付き</li>');
    expect(html).toContain('<li><a href="https://x.example">link</a></li>');
  });

  it('複合ドキュメントを一括変換できる', async () => {
    const md = [
      '# タイトル',
      '',
      '本文の*段落*です。',
      '',
      '- 項目A',
      '- 項目B',
      '',
      '1. 手順',
      '',
      '```',
      'code',
      '```',
    ].join('\n');
    const html = await run(md);
    const order = [
      html.indexOf('<h1>'),
      html.indexOf('<p>'),
      html.indexOf('<ul>'),
      html.indexOf('<ol>'),
      html.indexOf('<pre>'),
    ];
    for (const pos of order) expect(pos).toBeGreaterThanOrEqual(0);
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
    expect(html).toContain('<em>段落</em>');
  });

  it('空文字列は空のhtmlを返す', async () => {
    const html = await run('');
    expect(html).toBe('');
  });

  it('CRLF改行も処理できる', async () => {
    const html = await run('# 見出し\r\n\r\n段落');
    expect(html).toContain('<h1>見出し</h1>');
    expect(html).toContain('<p>段落</p>');
  });

  it('markdown が文字列でない入力はエラー', async () => {
    const r = await markdownToHtml.execute({ markdown: 42 }, ctx());
    expect(r.isError).toBe(true);
  });

  it('markdown 欠落の入力はエラー', async () => {
    const r = await markdownToHtml.execute({}, ctx());
    expect(r.isError).toBe(true);
  });

  it('過大入力はエラー(上限1,000,000文字)', async () => {
    const r = await markdownToHtml.execute({ markdown: 'a'.repeat(1_000_001) }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('大きすぎます');
  });
});
