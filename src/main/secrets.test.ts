import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, type SecretCipher } from './secrets';

function fakeCipher(available = true): SecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ 0x5a)),
    decrypt: (enc) => Buffer.from([...enc].map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-secrets-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SecretStore', () => {
  it('set/get/has が往復し、別インスタンスでも読める', () => {
    const file = join(dir, 'secrets.json');
    const store = new SecretStore(file, fakeCipher());
    expect(store.has('anthropic')).toBe(false);

    store.set('anthropic', 'sk-ant-test123');
    expect(store.get('anthropic')).toBe('sk-ant-test123');
    expect(store.has('anthropic')).toBe(true);
    expect(store.has('openai')).toBe(false);

    const store2 = new SecretStore(file, fakeCipher());
    expect(store2.get('anthropic')).toBe('sk-ant-test123');
  });

  it('ファイルに平文が書かれない', () => {
    const file = join(dir, 'secrets.json');
    new SecretStore(file, fakeCipher()).set('anthropic', 'sk-ant-PLAINTEXT');
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-PLAINTEXT');
  });

  it('暗号化が使えない環境では保存を拒否する(平文保存禁止)', () => {
    const store = new SecretStore(join(dir, 's.json'), fakeCipher(false));
    expect(() => store.set('anthropic', 'key')).toThrow();
  });
});

describe('M27-1: プリセット用キースロット', () => {
  it('gemini / groq / openrouter / kimi スロットが openai と独立に往復する', () => {
    const file = join(dir, 'secrets.json');
    const store = new SecretStore(file, fakeCipher());
    store.set('gemini', 'AIza-test');
    store.set('kimi', 'moonshot-test');
    store.set('openai', 'sk-openai');
    expect(store.get('gemini')).toBe('AIza-test');
    expect(store.get('kimi')).toBe('moonshot-test');
    expect(store.get('openai')).toBe('sk-openai');
    expect(store.has('groq')).toBe(false);
    expect(store.has('openrouter')).toBe(false);

    const store2 = new SecretStore(file, fakeCipher());
    expect(store2.get('gemini')).toBe('AIza-test');
    expect(store2.get('kimi')).toBe('moonshot-test');
    expect(readFileSync(file, 'utf8')).not.toContain('AIza-test'); // 平文保存禁止はスロットにも適用
    expect(readFileSync(file, 'utf8')).not.toContain('moonshot-test');
  });
});

describe('M91-6: サインアウト(delete)', () => {
  it('delete で鍵ごと消える(空文字を入れて has が true のまま残るのを避ける)', () => {
    const file = join(dir, 'secrets.json');
    const store = new SecretStore(file, fakeCipher());
    store.set('github', 'gho_token');
    expect(store.has('github')).toBe(true);
    store.delete('github');
    expect(store.has('github')).toBe(false);
    expect(store.get('github')).toBeNull();
    // 別インスタンス(ディスクから読み直し)でも消えている
    expect(new SecretStore(file, fakeCipher()).has('github')).toBe(false);
  });

  it('未登録スロットの delete は何も壊さない', () => {
    const store = new SecretStore(join(dir, 'secrets.json'), fakeCipher());
    expect(() => store.delete('github')).not.toThrow();
  });
});
