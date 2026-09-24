/** HTTP/2 帧解析（RFC 7540 §4.1）。原帧字节始终保留，解析结果只是派生层。 */

export type Direction = 'c2s' | 's2c';

export const FRAME_TYPES: Record<number, string> = {
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

export const FLAGS = {
  END_STREAM: 0x1,
  ACK: 0x1,
  END_HEADERS: 0x4,
  PADDED: 0x8,
  PRIORITY: 0x20,
} as const;

export interface FrameRecord {
  /** 稳定身份：案例包内唯一 id，导入后保持不变 */
  id: string;
  direction: Direction;
  /** 原帧字节（hex），原样保留 */
  raw: string;
  at?: { value: number | string; unit: string; basis?: string };
  offset?: { value: number | string; unit: string; basis?: string };
  scenarios?: string[];
}

export interface ParsedFrame {
  length: number;
  type: number;
  typeName: string;
  flags: number;
  streamId: number;
  /** 保留位被置位（stream id 超过 2^31-1） */
  reservedBitSet: boolean;
  payload: Buffer;
}

export class FrameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameParseError';
  }
}

export function parseFrame(raw: Buffer): ParsedFrame {
  if (raw.length < 9) throw new FrameParseError(`frame header truncated: ${raw.length} octets`);
  const length = raw.readUIntBE(0, 3);
  const type = raw[4];
  const flags = raw[5];
  const streamWord = raw.readUInt32BE(6);
  const reservedBitSet = (streamWord & 0x80000000) !== 0;
  const streamId = streamWord & 0x7fffffff;
  if (raw.length < 9 + length) {
    throw new FrameParseError(`frame payload truncated: want ${length}, have ${raw.length - 9}`);
  }
  return {
    length,
    type,
    typeName: FRAME_TYPES[type] ?? `UNKNOWN(${type})`,
    flags,
    streamId,
    reservedBitSet,
    payload: raw.subarray(9, 9 + length),
  };
}

export function frameFromHex(hex: string): Buffer {
  const clean = hex.replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new FrameParseError(`invalid hex frame: ${hex.slice(0, 32)}…`);
  }
  return Buffer.from(clean, 'hex');
}

export interface SettingEntry {
  id: number;
  name: string;
  value: number;
}

export const SETTINGS_NAMES: Record<number, string> = {
  0x1: 'HEADER_TABLE_SIZE',
  0x2: 'ENABLE_PUSH',
  0x3: 'MAX_CONCURRENT_STREAMS',
  0x4: 'INITIAL_WINDOW_SIZE',
  0x5: 'MAX_FRAME_SIZE',
  0x6: 'MAX_HEADER_LIST_SIZE',
};

export function parseSettingsPayload(payload: Buffer): SettingEntry[] {
  if (payload.length % 6 !== 0) {
    throw new FrameParseError(`SETTINGS payload ${payload.length} not a multiple of 6`);
  }
  const out: SettingEntry[] = [];
  for (let i = 0; i < payload.length; i += 6) {
    const id = payload.readUInt16BE(i);
    out.push({ id, name: SETTINGS_NAMES[id] ?? `UNKNOWN(${id})`, value: payload.readUInt32BE(i + 2) });
  }
  return out;
}
