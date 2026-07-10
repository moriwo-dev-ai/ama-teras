import { loadPlugins, type PluginLoadError } from './loader';
import type { ToolPlugin } from './types';

/**
 * ロード済みツールの登録簿。reload() は起動時と進化昇格直後に呼ばれる。
 * M13-2: 外部ツール(MCP)はファイルベースのロードと別枠で登録し、reload でも消えない。
 * 進化ジョブは自前の ToolRegistry(B worktree の plugins ディレクトリ)を作るため、
 * 外部ツールが進化ジョブへ波及することはない(guardrails で固定)。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolPlugin>();
  private external = new Map<string, ToolPlugin>();
  private loadErrors: PluginLoadError[] = [];
  /** M27-4: キルスイッチで無効化された名前→理由。reload 後も適用が持続する */
  private revokedNames = new Map<string, string>();

  constructor(
    private readonly pluginsDir: string,
    private readonly cacheDir: string,
  ) {}

  async reload(): Promise<void> {
    const { plugins, errors } = await loadPlugins(this.pluginsDir, this.cacheDir);
    this.tools = new Map(plugins.map(({ plugin }) => [plugin.name, plugin]));
    this.loadErrors = errors;
    this.applyRevocations();
  }

  /**
   * M27-4: キルスイッチ(失効リスト)によるプラグイン無効化。ロード済みなら即座に外し、
   * 以降の reload でも復活しない。理由は errors(ツール一覧のエラー表示)へ載せて
   * ユーザーに通知する。戻り値=この呼び出しで実際に無効化されたか
   */
  revoke(name: string, reason: string): boolean {
    this.revokedNames.set(name, reason);
    const had = this.tools.has(name) || this.external.has(name);
    this.applyRevocations();
    return had;
  }

  private applyRevocations(): void {
    for (const [name, reason] of this.revokedNames) {
      if (this.tools.delete(name) || this.external.delete(name)) {
        this.loadErrors.push({
          filePath: `revoked:${name}`,
          message: `キルスイッチにより無効化: ${reason}`,
        });
      }
    }
  }

  /**
   * 外部ツールを登録する。ファイルベースのプラグイン・既存外部ツールと名前が
   * 衝突する場合は登録せず、その名前を戻り値で返す(呼び出し側でエラー表示)。
   */
  registerExternal(plugins: ToolPlugin[]): { rejected: string[] } {
    const rejected: string[] = [];
    for (const p of plugins) {
      if (this.tools.has(p.name) || this.external.has(p.name)) {
        rejected.push(p.name);
        continue;
      }
      this.external.set(p.name, p);
    }
    return { rejected };
  }

  /** prefix に一致する外部ツールを登録解除する(サーバー切断・無効化時) */
  clearExternal(prefix: string): void {
    for (const name of [...this.external.keys()]) {
      if (name.startsWith(prefix)) this.external.delete(name);
    }
  }

  list(): ToolPlugin[] {
    return [...this.tools.values(), ...this.external.values()];
  }

  get(name: string): ToolPlugin | undefined {
    return this.tools.get(name) ?? this.external.get(name);
  }

  get errors(): PluginLoadError[] {
    return this.loadErrors;
  }
}
