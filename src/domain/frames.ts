/**
 * HTTP/2 帧解析/序列化 (RFC 7540 §4.1, §6)。
 * 原帧字节在导入层原样保留；这里只产出派生视图，解析失败附诊断、不丢原始数据。
 */
import type { FrameHeader, FrameTypeName, Quantity } from './types.ts';
import { qty } from './types.ts';

export const FRAME_HEADER_LEN = 9;

export const FRAME_TYPES: Record<number, FrameTypeName> = {
  0x0: 'DATA', 0x1: 'HEADERS', 0x2: 'PRIORITY', 0x3: 'RST_STREAM', 0x4: 'SETTINGS',
  0x5: 'PUSH_PROMISE', 0x6: 'PING', 0x7: 'GOAWAY', 0x8: 'WINDOW_UPDATE', 0x9: 'CONTINUATION',
};

export const FLAG = {
  END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20,
} as const;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error(`非法十六进制字节串（长度 ${clean.length}）`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseFrameHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < FRAME_HEADER_LEN) {
    return {
      length: qty(String(bytes.length), null, 'octet', [`帧头不足 9 字节（实得 ${bytes.length}）`]),
      type: -1, typeName: 'UNKNOWN', flags: 0,
      streamId: qty('', null, 'rfc7540:stream-id:31bit', ['帧头不完整，无法读取 stream id']),
    };
  }
  const length = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  const type = bytes[3];
  const flags = bytes[4];
  const streamId = ((bytes[5] & 0x7f) << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
  const diagnostics: string[] = [];
  if (bytes.length - FRAME_HEADER_LEN < length) {
    diagnostics.push(`声明长度 ${length} octet 超出实得负载 ${bytes.length - FRAME_HEADER_LEN} octet`);
  }
  return {
    length: qty(String(length), length, 'octet', diagnostics),
    type,
    typeName: FRAME_TYPES[type] ?? 'UNKNOWN',
    flags,
    streamId: qty(String(streamId), streamId, 'rfc7540:stream-id:31bit'),
  };
}

export function buildFrame(type: number, flags: number, streamId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_LEN + payload.length);
  out[0] = (payload.length >>> 16) & 0xff;
  out[1] = (payload.length >>> 8) & 0xff;
  out[2] = payload.length & 0xff;
  out[3] = type;
  out[4] = flags;
  out[5] = (streamId >>> 24) & 0x7f;
  out[6] = (streamId >>> 16) & 0xff;
  out[7] = (streamId >>> 8) & 0xff;
  out[8] = streamId & 0xff;
  out.set(payload, FRAME_HEADER_LEN);
  return out;
}

export interface ParsedPadding {
  padLength: Quantity | null;   // 无 PADDED 标志时为 null
  content: Uint8Array;          // 去掉 pad 长度字节与填充后的内容
  overflow: boolean;            // padding 越界：Pad Length >= 负载长度
}

/** DATA/HEADERS 的填充处理 (RFC 7540 §6.1)：Pad Length 必须小于负载长度。 */
export function stripPadding(payload: Uint8Array, padded: boolean): ParsedPadding {
  if (!padded) return { padLength: null, content: payload, overflow: false };
  if (payload.length === 0) {
    return { padLength: qty('0', null, 'octet', ['PADDED 置位但负载为空，无法读取 Pad Length']), content: payload, overflow: true };
  }
  const padLength = payload[0];
  if (padLength >= payload.length) {
    return {
      padLength: qty(String(padLength), padLength, 'octet', [`Pad Length ${padLength} octet 不小于负载 ${payload.length} octet`]),
      content: new Uint8Array(0),
      overflow: true,
    };
  }
  return {
    padLength: qty(String(padLength), padLength, 'octet'),
    content: payload.subarray(1, payload.length - padLength),
    overflow: false,
  };
}

export interface SettingsParam { id: number; value: number }

export function parseSettingsPayload(payload: Uint8Array): { params: SettingsParam[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const params: SettingsParam[] = [];
  if (payload.length % 6 !== 0) {
    diagnostics.push(`SETTINGS 负载 ${payload.length} octet 不是 6 的倍数，尾部 ${payload.length % 6} octet 保留在原位未解析`);
  }
  const usable = payload.length - (payload.length % 6);
  for (let i = 0; i < usable; i += 6) {
    params.push({
      id: (payload[i] << 8) | payload[i + 1],
      value: ((payload[i + 2] << 24) | (payload[i + 3] << 16) | (payload[i + 4] << 8) | payload[i + 5]) >>> 0,
    });
  }
  return { params, diagnostics };
}

export const SETTINGS_ID: Record<number, string> = {
  0x1: 'HEADER_TABLE_SIZE', 0x2: 'ENABLE_PUSH', 0x3: 'MAX_CONCURRENT_STREAMS',
  0x4: 'INITIAL_WINDOW_SIZE', 0x5: 'MAX_FRAME_SIZE', 0x6: 'MAX_HEADER_LIST_SIZE',
};
