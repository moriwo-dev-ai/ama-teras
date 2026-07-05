import type { ChatImageInput } from '../../shared/types';

/**
 * M14-2/3: チャット添付画像の検証(IPC・リモートREST共用)。
 * 1枚10MB(base64換算 ~13.3MB)・8枚まで。不正は例外(呼び出し側で 400/IPCエラー化)。
 */
export const MAX_IMAGE_B64_LENGTH = Math.ceil((10 * 1024 * 1024 * 4) / 3);
export const MAX_IMAGES_PER_MESSAGE = 8;

export function validateChatImages(value: unknown): ChatImageInput[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('images が不正');
  if (value.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`画像は${MAX_IMAGES_PER_MESSAGE}枚まで`);
  return value.map((v) => {
    const rec = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    const mediaType = rec?.['mediaType'];
    const data = rec?.['data'];
    if (
      typeof mediaType !== 'string' ||
      !mediaType.startsWith('image/') ||
      typeof data !== 'string' ||
      data === '' ||
      !/^[A-Za-z0-9+/=]+$/.test(data)
    ) {
      throw new Error('images が不正');
    }
    if (data.length > MAX_IMAGE_B64_LENGTH) throw new Error('画像が大きすぎる(1枚10MBまで)');
    const description = rec?.['description'];
    return {
      mediaType,
      data,
      ...(typeof description === 'string' ? { description: description.slice(0, 200) } : {}),
    };
  });
}
