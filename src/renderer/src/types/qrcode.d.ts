// M13-0: qrcode の最小型宣言。依存を qrcode / @modelcontextprotocol/sdk の2つに
// 限定する方針のため @types/qrcode は追加せず、使用するAPIだけをここで宣言する。
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
}
