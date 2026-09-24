// HTTP/2 帧层（RFC 7540 §4-§6）。解析保持宽容：原帧字节与坐标始终保留，
// 协议合法性由 replay 层裁决。所有长度单位为 octet（字节）。

export const FRAME_HEADER_OCTETS = 9;
export const FRAME_PAYLOAD_MAX = 16384;
export const MAX_STREAM_ID = 0x7fffffff;

export const FrameType = {
  DATA: 0x0,
  HEADERS: 0x1,
  PRIORITY: 0x2,
  RST_STREAM: 0x3,
  SETTINGS: 0x4,
  PUSH_PROMISE: 0x5,
  PING: 0x6,
  GOAWAY: 0x7,
  WINDOW_UPDATE: 0x8,
  CONTINUATION: 0x9,
} as const;

export const FrameFlags = {
  END_STREAM: 0x1,
  ACK: 0x1,
  END_HEADERS: 0x4,
  PADDED: 0x8,
  PRIORITY: 0x20,
} as const;

export const ErrorCode = {
  NO_ERROR: 0x0,
  PROTOCOL_ERROR: 0x1,
  INTERNAL_ERROR: 0x2,
  FLOW_CONTROL_ERROR: 0x3,
  SETTINGS_TIMEOUT: 0x4,
  STREAM_CLOSED: 0x5,
  FRAME_SIZE_ERROR: 0x6,
  REFUSED_STREAM: 0x7,
  CANCEL: 0x8,
  COMPRESSION_ERROR: 0x9,
  CONNECT_ERROR: 0xa,
  ENHANCE_YOUR_CALM: 0xb,
  INADEQUATE_SECURITY: 0xc,
  HTTP_1_1_REQUIRED: 0xd,
} as const;

export type Direction = 'c2s' | 's2c';
export type FrameTypeName = keyof typeof FrameType;

export interface RawFrame {
  /** 稳定身份：f<连接偏移>_<方向>，由原始字节序决定 */
  id: string;
  /** 原始表示：完整帧字节（含 9 字节帧头），base16 */
  bytesHex: string;
  direction: Direction;
  /** 坐标基准：该帧在本方向字节流中的偏移，单位 octet */
  offsetOctets: number;
  /** 时间线序号（导入顺序，从 0 开始） */
  seq: number;
}

export interface FrameHeader {
  length: number;
  type: number;
  flags: number;
  streamId: number;
  rBit: boolean;
}

export type FrameBody =
  | { kind: 'DATA'; padLength?: number; dataHex: string; paddingHex: string }
  | { kind: 'HEADERS'; padLength?: number; priority?: { depStreamId: number; exclusive: boolean; weight: number }; fragmentHex: string; paddingHex: string }
  | { kind: 'PRIORITY'; depStreamId: number; exclusive: boolean; weight: number }
  | { kind: 'RST_STREAM'; errorCode: number }
  | { kind: 'SETTINGS'; ack: boolean; params: { id: number; value: number }[] }
  | { kind: 'PING'; opaqueHex: string }
  | { kind: 'GOAWAY'; lastStreamId: number; errorCode: number; debugHex: string }
  | { kind: 'WINDOW_UPDATE'; increment: number }
  | { kind: 'CONTINUATION'; fragmentHex: string }
  | { kind: 'UNKNOWN'; rawHex: string };

export interface ParsedFrame {
  raw: RawFrame;
  header: FrameHeader;
  body: FrameBody;
  /** 解析期诊断（非协议裁决；无法转换的值留在原处） */
  parseDiagnostics: string[];
}

export function hasFlag(flags: number, f: number): boolean {
  return (flags & f) === f;
}

export function frameTypeName(type: number): string {
  for (const [name, code] of Object.entries(FrameType)) {
    if (code === type) return name;
  }
  return `UNKNOWN(0x${type.toString(16)})`;
}

function u24(b: Uint8Array, i: number): number {
  return (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
}

export function parseFrame(bytes: Uint8Array, direction: Direction, seq: number, offsetOctets: number, id?: string): ParsedFrame {
  const diagnostics: string[] = [];
  if (bytes.length < FRAME_HEADER_OCTETS) {
    diagnostics.push(`frame truncated: ${bytes.length} octets < ${FRAME_HEADER_OCTETS} header octets`);
  }
  const length = u24(bytes, 0);
  const type = bytes[3]!;
  const flags = bytes[4]!;
  const idWord = (bytes[5]! << 24) | (bytes[6]! << 16) | (bytes[7]! << 8) | bytes[8]!;
  const rBit = (idWord & 0x80000000) !== 0;
  const streamId = idWord >>> 1;
  const raw: RawFrame = {
    id: id ?? `f${offsetOctets}_${direction}`,
    bytesHex: toHex(bytes),
    direction,
    offsetOctets,
    seq,
  };
  const header: FrameHeader = { length, type, flags, streamId, rBit };
  const payload = bytes.subarray(FRAME_HEADER_OCTETS, FRAME_HEADER_OCTETS + length);
  if (payload.length < length) {
    diagnostics.push(`payload truncated: declared ${length} octets, present ${payload.length} octets`);
  }
  let body: FrameBody;
  let p = 0;
  const readPad = (): number | undefined =>
    hasFlag(flags, FrameFlags.PADDED) ? payload[p++] : undefined;
  try {
    switch (type) {
      case FrameType.DATA: {
        const padLength = readPad();
        let dataHex: string;
        let paddingHex = '';
        if (padLength !== undefined) {
          if (padLength >= payload.length) {
            diagnostics.push(`padding overflow: pad length ${padLength} octets >= frame payload ${payload.length} octets`);
            dataHex = toHex(payload.subarray(p));
          } else {
            dataHex = toHex(payload.subarray(p, payload.length - padLength));
            paddingHex = toHex(payload.subarray(payload.length - padLength));
          }
        } else {
          dataHex = toHex(payload);
        }
        body = { kind: 'DATA', padLength, dataHex, paddingHex };
        break;
      }
      case FrameType.HEADERS: {
        const padLength = readPad();
        let priority: { depStreamId: number; exclusive: boolean; weight: number } | undefined;
        if (hasFlag(flags, FrameFlags.PRIORITY)) {
          const word = (payload[p]! << 24) | (payload[p + 1]! << 16) | (payload[p + 2]! << 8) | payload[p + 3]!;
          priority = { depStreamId: word >>> 1, exclusive: (word & 0x80000000) !== 0, weight: (payload[p + 4] ?? 0) + 1 };
          p += 5;
        }
        const end = padLength !== undefined && padLength < payload.length ? payload.length - padLength : payload.length;
        if (padLength !== undefined && padLength >= payload.length) {
          diagnostics.push(`padding overflow: pad length ${padLength} octets >= frame payload ${payload.length} octets`);
        }
        const fragmentHex = toHex(payload.subarray(p, end));
        const paddingHex = padLength !== undefined && padLength < payload.length ? toHex(payload.subarray(end)) : '';
        body = { kind: 'HEADERS', padLength, priority, fragmentHex, paddingHex };
        break;
      }
      case FrameType.PRIORITY: {
        const word = (payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!;
        body = { kind: 'PRIORITY', depStreamId: word >>> 1, exclusive: (word & 0x80000000) !== 0, weight: (payload[4] ?? 0) + 1 };
        break;
      }
      case FrameType.RST_STREAM:
        body = { kind: 'RST_STREAM', errorCode: ((payload[0] ?? 0) << 24) | ((payload[1] ?? 0) << 16) | ((payload[2] ?? 0) << 8) | (payload[3] ?? 0) };
        break;
      case FrameType.SETTINGS: {
        const ack = hasFlag(flags, FrameFlags.ACK);
        const params: { id: number; value: number }[] = [];
        if (payload.length % 6 !== 0) diagnostics.push(`settings payload ${payload.length} octets not a multiple of 6`);
        for (let i = 0; i + 5 < payload.length; i += 6) {
          params.push({ id: (payload[i]! << 8) | payload[i + 1]!, value: (payload[i + 2]! * 0x1000000) + ((payload[i + 3]! << 16) | (payload[i + 4]! << 8) | payload[i + 5]!) });
        }
        body = { kind: 'SETTINGS', ack, params };
        break;
      }
      case FrameType.PING:
        body = { kind: 'PING', opaqueHex: toHex(payload) };
        break;
      case FrameType.GOAWAY: {
        const last = ((payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!) >>> 1;
        const err = (payload[4]! << 24) | (payload[5]! << 16) | (payload[6]! << 8) | payload[7]!;
        body = { kind: 'GOAWAY', lastStreamId: last, errorCode: err >>> 0, debugHex: toHex(payload.subarray(8)) };
        break;
      }
      case FrameType.WINDOW_UPDATE:
        body = { kind: 'WINDOW_UPDATE', increment: (((payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!) & 0x7fffffff) >>> 0 };
        break;
      case FrameType.CONTINUATION:
        body = { kind: 'CONTINUATION', fragmentHex: toHex(payload) };
        break;
      default:
        body = { kind: 'UNKNOWN', rawHex: toHex(payload) };
    }
  } catch {
    diagnostics.push('payload structure unreadable; raw bytes retained in place');
    body = { kind: 'UNKNOWN', rawHex: toHex(payload) };
  }
  if (length > FRAME_PAYLOAD_MAX) diagnostics.push(`frame size ${length} octets exceeds ${FRAME_PAYLOAD_MAX} octet maximum`);
  return { raw, header, body, parseDiagnostics: diagnostics };
}

export function buildFrame(type: number, flags: number, streamId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_OCTETS + payload.length);
  out[0] = (payload.length >> 16) & 0xff;
  out[1] = (payload.length >> 8) & 0xff;
  out[2] = payload.length & 0xff;
  out[3] = type;
  out[4] = flags;
  out[5] = (streamId >>> 24) & 0x7f;
  out[6] = (streamId >>> 16) & 0xff;
  out[7] = (streamId >>> 8) & 0xff;
  out[8] = streamId & 0xff;
  out.set(payload, FRAME_HEADER_OCTETS);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
