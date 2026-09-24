/**
 * HTTP/2 帧层（RFC 7540 §4/§6）。
 * 只做无状态的单帧解析；原帧字节 rawHex 在导入层原样保留。
 * 任何无法规范化的量留在原地并附 diagnostic，绝不丢弃。
 */
import { q, BASIS, UNIT } from './units.ts';

export type KnownDirection = 'C2S' | 'S2C';
export type FrameDirection = KnownDirection | 'UNK';

export const FRAME_TYPE = {
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

export const FRAME_TYPE_NAME: Record<number, string> = {
  0x0: 'DATA',
  0x1: 'HEADERS',
  0x2: 'PRIORITY',
  0x3: 'RST_STREAM',
  0x4: 'SETTINGS',
  0x5: 'PUSH_PROMISE',
  0x6: 'PING',
  0x7: 'GOAWAY',
  0x8: 'WINDOW_UPDATE',
  0x9: 'CONTINUATION',
};

export const FLAG = {
  ACK: 0x1,
  END_STREAM: 0x1,
  END_HEADERS: 0x4,
  PADDED: 0x8,
  PRIORITY: 0x20,
} as const;

export const SETTINGS_ID = {
  HEADER_TABLE_SIZE: 0x1,
  ENABLE_PUSH: 0x2,
  MAX_CONCURRENT_STREAMS: 0x3,
  INITIAL_WINDOW_SIZE: 0x4,
  MAX_FRAME_SIZE: 0x5,
  MAX_HEADER_LIST_SIZE: 0x6,
} as const;

export interface Diagnostic {
  code: string;
  message: string;
  /** 违反帧内字节偏移（byte 坐标，9 字节帧头之后） */
  at?: { v: number; u: string; b: string };
}

export interface SettingParam {
  id: number;
  idName: string;
  /** 原始 32 位数值（导入保留原始表示） */
  rawValue: number;
}

export interface ParsedFrame {
  seq: number;
  direction: FrameDirection;
  rawHex: string;
  rawLength: number;
  length: number;
  type: number;
  typeName: string;
  flags: number;
  streamIdRaw: number;
  streamId31: number;
  reservedBitSet: boolean;
  payloadHex: string;
  diagnostics: Diagnostic[];
  settingsParams?: SettingParam[];
  padLength?: number;
  headerBlock?: { offset: number; length: number };
  endStream: boolean;
  endHeaders: boolean;
  dataBytes?: number;
}

export function isFrameType(n: number): boolean {
  return n in FRAME_TYPE_NAME;
}

/** 构造一帧（案例包构建器使用）。 */
export function buildFrame(
  type: number,
  flags: number,
  streamIdRaw: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  out[0] = (payload.length >> 16) & 0xff;
  out[1] = (payload.length >> 8) & 0xff;
  out[2] = payload.length & 0xff;
  out[3] = type;
  out[4] = flags;
  const dv = new DataView(out.buffer);
  dv.setUint32(5, streamIdRaw >>> 0);
  out.set(payload, 9);
  return out;
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 解析一帧。返回的诊断不抛异常；调用方保留 rawHex。
 */
export function parseFrame(
  seq: number,
  direction: FrameDirection,
  rawHex: string,
): ParsedFrame {
  const f: ParsedFrame = {
    seq,
    direction,
    rawHex: rawHex.toLowerCase().replace(/\s+/g, ''),
    rawLength: 0,
    length: 0,
    type: 0,
    typeName: 'UNKNOWN',
    flags: 0,
    streamIdRaw: 0,
    streamId31: 0,
    reservedBitSet: false,
    payloadHex: '',
    diagnostics: [],
    endStream: false,
    endHeaders: false,
  };

  const hex = f.rawHex;
  if (hex.length < 18 || hex.length % 2 !== 0) {
    f.diagnostics.push({
      code: 'FRAME_TRUNCATED',
      message: `不足 9 字节帧头或非偶数字节: ${hex.length / 2} byte`,
    });
    f.rawLength = hex.length / 2;
    return f;
  }
  const bytes = Uint8Array.from(
    hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
  );
  f.rawLength = bytes.length;
  f.length = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  f.type = bytes[3];
  f.typeName = FRAME_TYPE_NAME[f.type] ?? `UNKNOWN(0x${f.type.toString(16)})`;
  f.flags = bytes[4];
  f.streamIdRaw =
    ((bytes[5] << 24) >>> 0) |
    (bytes[6] << 16) |
    (bytes[7] << 8) |
    bytes[8];
  f.streamId31 = f.streamIdRaw & 0x7fffffff;
  f.reservedBitSet = (f.streamIdRaw & 0x80000000) !== 0;
  f.endStream = (f.flags & FLAG.END_STREAM) !== 0;
  f.endHeaders = (f.flags & FLAG.END_HEADERS) !== 0;

  if (bytes.length !== 9 + f.length) {
    f.diagnostics.push({
      code: 'FRAME_LENGTH_MISMATCH',
      message: `帧头声明 length=${f.length}，实际 payload=${bytes.length - 9}`,
      at: q(0, UNIT.BYTE, BASIS.RFC7540_FRAME_HEADER),
    });
  }
  const payload = bytes.subarray(9, Math.min(9 + f.length, bytes.length));
  f.payloadHex = toHex(payload);

  if (f.reservedBitSet || f.streamId31 === 0x7fffffff) {
    f.diagnostics.push({
      code: 'STREAM_ID_EXHAUSTED',
      message: `stream id 原始值 0x${f.streamIdRaw
        .toString(16)
        .padStart(8, '0')}：保留位被置 1 或已达 31 位上限 2^31-1`,
      at: q(5, UNIT.BYTE, BASIS.RFC7540_FRAME_HEADER),
    });
  }

  switch (f.type) {
    case FRAME_TYPE.SETTINGS: {
      f.settingsParams = [];
      if (streamIdMustBeZero(f)) {
        if (f.endStream && f.length > 0) {
          f.diagnostics.push({
            code: 'SETTINGS_ACK_WITH_PAYLOAD',
            message: `SETTINGS ACK 帧携带 ${f.length} byte 负载；ACK 只用于确认，不得携带参数`,
            at: q(0, UNIT.BYTE, 'rfc7540-settings-ack'),
          });
        }
        if (!f.endStream && f.length % 6 !== 0) {
          f.diagnostics.push({
            code: 'SETTINGS_FRAME_SIZE',
            message: `SETTINGS 负载长度 ${f.length} 不是 6 的倍数`,
          });
        }
        for (let i = 0; i + 6 <= payload.length; i += 6) {
          const id = (payload[i + 0] << 8) | payload[i + 1];
          const value =
            (payload[i + 2] * 0x1000000 +
              ((payload[i + 3] << 16) | (payload[i + 4] << 8) | payload[i + 5])) >>>
            0;
          f.settingsParams.push({
            id: id & 0xffff,
            idName: settingsName(id & 0xffff),
            rawValue: value,
          });
        }
      }
      break;
    }
    case FRAME_TYPE.DATA:
    case FRAME_TYPE.HEADERS:
    case FRAME_TYPE.CONTINUATION: {
      let off = 0;
      const padded = (f.flags & FLAG.PADDED) !== 0;
      if (f.type === FRAME_TYPE.DATA || f.type === FRAME_TYPE.HEADERS) {
        if (padded) {
          if (payload.length < 1) {
            f.diagnostics.push(paddingDiag(0, 0));
          } else {
            f.padLength = payload[0];
            off = 1;
            const available = payload.length - 1;
            if (f.padLength > available) {
              f.diagnostics.push(paddingDiag(f.padLength, available));
            }
          }
        }
      }
      if (f.type === FRAME_TYPE.HEADERS && (f.flags & FLAG.PRIORITY) !== 0) {
        off += 5;
      }
      if (off <= payload.length) {
        const validPadding = f.padLength !== undefined && f.padLength <= payload.length - (off >= 1 ? 1 : 0);
        const blockLen = payload.length - off - (validPadding ? f.padLength! : 0);
        f.headerBlock = { offset: off, length: Math.max(0, blockLen) };
      }
      if (f.type === FRAME_TYPE.DATA && !f.diagnostics.some((d) => d.code === 'PADDING_OUT_OF_BOUNDS')) {
        f.dataBytes = Math.max(0, payload.length - off - (f.padLength ?? 0));
      }
      break;
    }
    default:
      break;
  }
  return f;
}

function streamIdMustBeZero(f: ParsedFrame): boolean {
  if (f.streamId31 !== 0 || f.reservedBitSet) {
    f.diagnostics.push({
      code: 'STREAM_ID_MUST_BE_ZERO',
      message: `${f.typeName} 帧 stream id 必须为 0，实际 0x${f.streamIdRaw.toString(16)}`,
    });
    return false;
  }
  return true;
}

function paddingDiag(padLength: number, available: number): Diagnostic {
  return {
    code: 'PADDING_OUT_OF_BOUNDS',
    message: `Pad Length=${padLength} 超过可用负载 ${available} byte`,
    at: q(9, UNIT.BYTE, 'rfc7540-pad-length'),
  };
}

export function settingsName(id: number): string {
  const entry = Object.entries(SETTINGS_ID).find(([, v]) => v === id);
  return entry ? entry[0] : `UNKNOWN(0x${id.toString(16)})`;
}
