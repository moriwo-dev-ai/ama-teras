import { useState } from 'react';
import type { RemoteApi } from '../api';
import { useRemoteStore } from '../store';

export function EvolutionView({ api }: { api: RemoteApi }): JSX.Element {
  const { jobs, promotions, setTab } = useRemoteStore();
  const [description, setDescription] = useState('');
  const [expectedIO, setExpectedIO] = useState('');
  const [notice, setNotice] = useState('');

  const enqueue = async (): Promise<void> => {
    if (!description.trim()) return;
    setNotice('');
    try {
      const { jobId } = await api.evolutionEnqueue(description.trim(), expectedIO.trim());
      setNotice(`ジョブ #${jobId} を投入した`);
      setDescription('');
      setExpectedIO('');
    } catch (err) {
      setNotice(`投入失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const sorted = [...jobs].sort((a, b) => b.id - a.id);

  return (
    <div className="content">
      {promotions.length > 0 && (
        <div className="warn-banner" onClick={() => setTab('approvals')}>
          🧬 昇格承認待ちが {promotions.length} 件ある(承認タブで対応)
        </div>
      )}

      <div className="card enqueue">
        <h3>新しい能力をリクエスト</h3>
        <textarea
          rows={2}
          placeholder="欲しいツールの説明(例: CSVをMarkdown表にする)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <input
          placeholder="期待する入出力(例: 入力=CSV文字列 / 出力=Markdown)"
          value={expectedIO}
          onChange={(e) => setExpectedIO(e.target.value)}
        />
        <div className="btnrow">
          <button className="btn-allow" disabled={!description.trim()} onClick={() => void enqueue()}>
            進化ジョブを投入
          </button>
        </div>
        {notice && <p className="muted">{notice}</p>}
      </div>

      {sorted.length === 0 && <p className="muted">進化ジョブはまだ無い。</p>}
      {sorted.map((job) => (
        <div key={job.id} className="job">
          <div>
            #{job.id} {job.toolName ?? job.description.slice(0, 40)}
            <span className={`st ${job.status}`}>{job.status}</span>
          </div>
          {job.gates.length > 0 && (
            <div className="log">
              {job.gates.map((g) => `${g.ok ? '✅' : '❌'} ${g.name}`).join(' / ')}
            </div>
          )}
          {job.error && <div className="log">⚠ {job.error}</div>}
          {job.log.length > 0 && <div className="log">{job.log.slice(-3).join('\n')}</div>}
        </div>
      ))}
    </div>
  );
}
