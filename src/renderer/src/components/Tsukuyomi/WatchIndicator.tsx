import { useEffect, useRef } from 'react';
import { useTsukuyomiStore } from '../../stores/tsukuyomi';
import { CameraWatch } from './cameraWatch';

/**
 * M42-3(TUKU-yomi): 稼働中の可視インジケータ(鉄則5)。
 *
 * カメラが動いている間は**必ず**「📷 見守り中」が出る。消す設定は作らない。
 * **停止は常に1クリック**(押すと設定の camera も落ちるので、再起動しても戻らない)。
 *
 * カメラの実体(getUserMedia)もここが持つ。フレームはメモリ内だけで扱い、
 * ディスクにも API にも出さない(Stage 3 の在席検知はローカル完結)。
 */
export function WatchIndicator(): JSX.Element | null {
  const status = useTsukuyomiStore((s) => s.status);
  const refresh = useTsukuyomiStore((s) => s.refresh);
  const watchRef = useRef<CameraWatch | null>(null);
  const cameraOn = status?.camera === true;
  // M42-4: 映像理解(=APIへ選別フレームを送る)は別トグル。OFFなら1枚も送らない
  const understandOn = status?.cameraUnderstanding === true;

  useEffect(() => {
    if (!cameraOn) {
      watchRef.current?.stop();
      watchRef.current = null;
      return;
    }
    if (watchRef.current !== null) return;
    const watch = new CameraWatch({
      onPresenceEvent: (event, text) => {
        void window.api.tsukuyomiPresence(event, text);
      },
      // 理解OFFなら未注入 = カメラのフレームは1枚もアプリの外に出ない
      ...(understandOn
        ? {
            onFrameForUnderstanding: (jpegBase64) => {
              // 上限(1時間6枚・1日50枚)を超えていたら main が null を返して送らない
              void window.api.tsukuyomiFrame(jpegBase64).then(() => refresh());
            },
          }
        : {}),
    });
    watchRef.current = watch;
    void watch.start();
    return () => {
      watch.stop();
      watchRef.current = null;
    };
  }, [cameraOn, understandOn, refresh]);

  if (status === null || (!status.camera && !status.ears)) return null;

  const stopAll = (): void => {
    void window.api.settingsGet().then((cfg) => {
      const tsu = cfg.tsukuyomi ?? { enabled: true };
      return window.api
        .settingsSet({ ...cfg, tsukuyomi: { ...tsu, camera: false, cameraUnderstanding: false, ears: false } })
        .then(() => refresh());
    });
  };

  return (
    <div className="flex items-center justify-center gap-3 border-b border-indigo-800 bg-indigo-950/70 px-4 py-1 text-xs text-indigo-200">
      {status.camera && <span>📷 見守り中(カメラ)</span>}
      {status.ears && <span>👂 聴取中(マイク)</span>}
      <button className="rounded border border-indigo-600 px-2 py-0.5 text-indigo-100 hover:bg-indigo-900" onClick={stopAll}>
        停止
      </button>
    </div>
  );
}
