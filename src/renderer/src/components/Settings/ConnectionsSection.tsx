import { McpSection } from './McpSection';
import { RemoteAccessSection } from './RemoteAccessSection';
import { UsageSection } from './UsageSection';

/**
 * M26-5: 設定「接続」タブ — リモートアクセス / MCP / 使用量。
 * 既存セクションを束ねるだけ(それぞれが自前で状態を持つ)
 */
export function ConnectionsSection(): JSX.Element {
  return (
    <div className="space-y-4">
      <UsageSection />
      <RemoteAccessSection />
      <McpSection />
    </div>
  );
}
