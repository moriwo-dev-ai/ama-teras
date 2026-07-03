import { loadPlugins, type PluginLoadError } from './loader';
import type { ToolPlugin } from './types';

/** ロード済みツールの登録簿。reload() は起動時と進化昇格直後に呼ばれる */
export class ToolRegistry {
  private tools = new Map<string, ToolPlugin>();
  private loadErrors: PluginLoadError[] = [];

  constructor(
    private readonly pluginsDir: string,
    private readonly cacheDir: string,
  ) {}

  async reload(): Promise<void> {
    const { plugins, errors } = await loadPlugins(this.pluginsDir, this.cacheDir);
    this.tools = new Map(plugins.map(({ plugin }) => [plugin.name, plugin]));
    this.loadErrors = errors;
  }

  list(): ToolPlugin[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolPlugin | undefined {
    return this.tools.get(name);
  }

  get errors(): PluginLoadError[] {
    return this.loadErrors;
  }
}
