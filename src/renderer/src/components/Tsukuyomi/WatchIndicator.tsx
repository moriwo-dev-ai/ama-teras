import { useEffect, useRef } from 'react';
import { useTsukuyomiStore } from '../../stores/tsukuyomi';
import { CameraWatch } from './cameraWatch';
import { EarsWatch } from './earsWatch';

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
  const earsRef = useRef<EarsWatch | null>(null);
  const addPending = useTsukuyomiStore((s) => s.addPending);
  const pushToTalk = useTsukuyomiStore((s) => s.pushToTalk);
  const micDeviceId = status?.micDeviceId;
  const earsOn = status?.ears === true;
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

  // M42-5b: 常時聴取。VADで切り出した発話区間だけをローカル文字起こしへ回す
  useEffect(() => {
    if (!earsOn) {
      earsRef.current?.stop();
      earsRef.current = null;
      return;
    }
    if (earsRef.current !== null) return;
    const ears = new EarsWatch({
      ...(micDeviceId !== undefined ? { deviceId: micDeviceId } : {}),
      onUtterance: (wav) => {
        void window.api.tsukuyomiTranscribe(wav, 'ears').then((r) => {
          // 抽出できたものは「確認待ち」に積む(帳には勝手に入れない=岩戸の思想)
          if (r.items.length > 0) addPending(r.items);
        });
      },
    });
    earsRef.current = ears;
    void ears.start();
    return () => {
      ears.stop();
      earsRef.current = null;
    };
  }, [earsOn, addPending, micDeviceId]);

  // 押して話すの最中は常時聴取を黙らせる(同じ声を2経路で拾うと候補が2つできる)
  useEffect(() => {
    earsRef.current?.setPaused(pushToTalk);
  }, [pushToTalk]);

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
      {/* クラウド文字起こしの時は「声がクラウドに出ている」ことを常に見せる(鉄則5) */}
      {status.ears && (
        <span>{status.sttMode === 'cloud' ? '👂☁ 聴取中(マイク→クラウド)' : '👂 聴取中(マイク)'}</span>
      )}
      <button className="rounded border border-indigo-600 px-2 py-0.5 text-indigo-100 hover:bg-indigo-900" onClick={stopAll}>
        停止
      </button>
    </div>
  );
}
