import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * M15-1: 左右ペインの共通コンテナ。
 * - ドラッグでリサイズ可(境界バー)・折りたたみ可。状態は localStorage に保存
 * - ウィンドウ幅が狭い(<900px)ときは通常フローから外れ、開いたらオーバーレイ表示
 */

const NARROW_PX = 900;
const MIN_W = 180;
const MAX_W = 560;

export interface PaneState {
  width: number;
  collapsed: boolean;
}

export function usePaneState(storageKey: string, defaultWidth: number): {
  state: PaneState;
  setWidth: (w: number) => void;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
} {
  const [state, setState] = useState<PaneState>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PaneState>;
        return {
          width: typeof parsed.width === 'number' ? Math.min(Math.max(parsed.width, MIN_W), MAX_W) : defaultWidth,
          collapsed: parsed.collapsed === true,
        };
      }
    } catch {
      /* 壊れた保存値は既定に戻す */
    }
    return { width: defaultWidth, collapsed: false };
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  }, [storageKey, state]);

  return {
    state,
    setWidth: useCallback((w: number) => setState((s) => ({ ...s, width: Math.min(Math.max(w, MIN_W), MAX_W) })), []),
    toggle: useCallback(() => setState((s) => ({ ...s, collapsed: !s.collapsed })), []),
    setCollapsed: useCallback((v: boolean) => setState((s) => ({ ...s, collapsed: v })), []),
  };
}

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

export function SidePane({
  side,
  width,
  collapsed,
  narrow,
  onResize,
  onClose,
  children,
}: {
  side: 'left' | 'right';
  width: number;
  collapsed: boolean;
  narrow: boolean;
  onResize: (w: number) => void;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element | null {
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return;
      onResize(side === 'left' ? e.clientX : window.innerWidth - e.clientX);
    };
    const onUp = (): void => {
      dragging.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [side, onResize]);

  if (collapsed) return null;

  const handle = (
    <div
      className="w-1 shrink-0 cursor-col-resize bg-zinc-800 hover:bg-blue-600"
      onMouseDown={() => {
        dragging.current = true;
        document.body.style.userSelect = 'none';
      }}
    />
  );

  const body = (
    <div
      className={`flex min-h-0 flex-col overflow-hidden bg-zinc-950 ${
        narrow ? 'h-full shadow-2xl' : ''
      }`}
      style={{ width }}
    >
      {children}
    </div>
  );

  if (narrow) {
    // 狭幅: オーバーレイ表示(背景クリックで閉じる)
    return (
      <div className="fixed inset-0 z-30 flex" onClick={onClose}>
        <div className="absolute inset-0 bg-black/50" />
        <div
          className={`relative z-10 flex h-full ${side === 'right' ? 'ml-auto' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          {side === 'right' && handle}
          {body}
          {side === 'left' && handle}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 shrink-0">
      {side === 'right' && handle}
      {body}
      {side === 'left' && handle}
    </div>
  );
}
