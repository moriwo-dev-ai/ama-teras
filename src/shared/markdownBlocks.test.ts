import { describe, expect, it } from 'vitest';
import { listCodeBlocks, splitMarkdownSegments } from './markdownBlocks';

describe('splitMarkdownSegments / listCodeBlocks(M16-3)', () => {
  it('テキストとコードブロックを言語付きで分割する', () => {
    const md = '説明です\n```ts\nconst x = 1;\nconst y = 2;\n```\n続きの文';
    expect(splitMarkdownSegments(md)).toEqual([
      { type: 'text', content: '説明です' },
      { type: 'code', lang: 'ts', content: 'const x = 1;\nconst y = 2;' },
      { type: 'text', content: '続きの文' },
    ]);
  });

  it('言語なしフェンス・複数ブロック', () => {
    const blocks = listCodeBlocks('a\n```\nplain\n```\nb\n```python\nprint(1)\n```');
    expect(blocks).toEqual([
      { lang: null, code: 'plain' },
      { lang: 'python', code: 'print(1)' },
    ]);
  });

  it('未クローズフェンス(ストリーミング途中)はそこまでをコードとして扱う', () => {
    const segs = splitMarkdownSegments('前置き\n```js\nconsole.log(1);');
    expect(segs).toEqual([
      { type: 'text', content: '前置き' },
      { type: 'code', lang: 'js', content: 'console.log(1);' },
    ]);
  });

  it('コード内の ``` 風の行(インデント付き)はフェンス終端にしない', () => {
    const segs = splitMarkdownSegments('```md\n  ```\ninner\n```');
    expect(segs).toEqual([{ type: 'code', lang: 'md', content: '  ```\ninner' }]);
  });

  it('コードブロック無しは全体がテキスト', () => {
    expect(splitMarkdownSegments('ただの文章\n2行目')).toEqual([
      { type: 'text', content: 'ただの文章\n2行目' },
    ]);
    expect(listCodeBlocks('ただの文章')).toEqual([]);
  });
});
