import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderId } from '../shared/types';

/** OS暗号化の抽象(テストではフェイクを注入)。実体は Electron safeStorage(WindowsはDPAPI) */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

/**
 * APIキーの暗号化保管。平文保存禁止(CLAUDE.md)。
 * ファイルには base64(暗号化バイト列) のみを書く。
 */
export class SecretStore {
  private cache = new Map<ProviderId, string>();

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}

  private read(): Record<string, string> {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof raw !== 'object' || raw === null) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  set(provider: ProviderId, apiKey: string): void {
    if (!this.cipher.isAvailable()) {
      throw new Error('OSの暗号化ストレージが利用できないため、APIキーを保存できない');
    }
    const data = this.read();
    data[provider] = this.cipher.encrypt(apiKey).toString('base64');
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    this.cache.set(provider, apiKey);
  }

  get(provider: ProviderId): string | null {
    const cached = this.cache.get(provider);
    if (cached !== undefined) return cached;
    const data = this.read();
    const encrypted = data[provider];
    if (encrypted === undefined) return null;
    try {
      const plain = this.cipher.decrypt(Buffer.from(encrypted, 'base64'));
      this.cache.set(provider, plain);
      return plain;
    } catch {
      return null;
    }
  }

  has(provider: ProviderId): boolean {
    return this.get(provider) !== null;
  }
}
