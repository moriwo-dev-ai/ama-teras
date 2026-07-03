import type { DiffLine } from '../../../../shared/types';

const STYLES: Record<DiffLine['kind'], string> = {
  add: 'bg-green-950 text-green-300',
  del: 'bg-red-950 text-red-300',
  same: 'text-zinc-400',
};

const PREFIX: Record<DiffLine['kind'], string> = { add: '+', del: '-', same: ' ' };

export function DiffView({ lines }: { lines: DiffLine[] }): JSX.Element {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs leading-5">
      {lines.map((l, i) => (
        <div key={i} className={STYLES[l.kind]}>
          {PREFIX[l.kind]} {l.text}
        </div>
      ))}
    </pre>
  );
}
