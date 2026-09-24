import { bytesToHex, concatBytes, sliceBytes, toUint32, u31, uint32 } from "./bytes.ts";

export const FRAME_TYPES = {
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

export const FRAME_TYPE_NAMES: Record<number, string> = {
  0: "DATA",
  1: "HEADERS",
  2: "PRIORITY",
  3: "RST_STREAM",
  4: "SETTINGS",
  5: "PUSH_PROMISE",
  6: "PING",
  7: "GOAWAY",
  8: "WINDOW_UPDATE",
  9: "CONTINUATION",
};

export const FLAGS = {
  END_STREAM: 0x1,
  ACK: 0x1,
  END_HEADERS: 0x4,
  PADDED: 0x8,
  PRIORITY: 0x20,
} as const;

export const FRAME_HEADER_LENGTH = 9;
export const MAX_U31 = 0x7fffffff;

export type Direction = "c2s" | "s2c";

/** 原帧字节的一个直接来源片段（原始表示始终保留，规范化只发生在派生层）。 */
export interface RawHunk {
  /** 在材料文本中的字符坐标，例如 trace 第 7 行的 12-40 列。 */
  sourceLine: number;
  sourceColStart: number;
  sourceColEnd: number;
  /** 原始 hex 表示，逐字保留。 */
  rawHex: string;
  bytes: number[];
}

export interface ParseDiagnostic {
  hunkIndex: number;
  code: string;
  message: string;
}

export interface ParsedFrame {
  /** 稳定身份：材料 id + 来源行 + 顺序 + 原始字节。单源突变只影响其 hunk 上的帧。 */
  id: string;
  order: number;
  direction: Direction;
  hunkIndex: number;
  type: number;
  typeName: string;
  flags: number;
  streamId: number; // 逻辑 31 位值
  reservedBit: 0 | 1;
  payload: number[];
  /** 若 9 字节帧头之后字节不足，帧仍保留并标记截断。 */
  truncated?: number;
}

export interface ParsedTrace {
  frames: ParsedFrame[];
  /** 帧顺序 -> 原始 hunk（与 frame.hunkIndex 对应）。 */
  hunks: RawHunk[];
  diagnostics: ParseDiagnostic[];
}

export function buildFrame(type: number, flags: number, streamId: number, payload: ArrayLike<number>): number[] {
  const len = payload.length;
  const head = [
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    type,
    flags,
    ...toUint32(streamId & 0x7fffffff),
  ];
  return concatBytes([head, payload]);
}

export function parseFrames(hunks: RawHunk[], materialStable: string): ParsedTrace {
  const frames: ParsedFrame[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let order = 0;
  hunks.forEach((hunk, hunkIndex) => {
    const data = hunk.bytes;
    if (data.length === 0) {
      diagnostics.push({ hunkIndex, code: "EMPTY_HUNK", message: "空帧片段，没有任何字节。" });
      return;
    }
    if (data.length < FRAME_HEADER_LENGTH) {
      diagnostics.push({
        hunkIndex,
        code: "TRUNCATED_FRAME_HEADER",
        message: `仅有 ${data.length} 字节，不足 9 字节帧头（缺 ${FRAME_HEADER_LENGTH - data.length} 字节）；保留原片段。`,
      });
      return;
    }
    const length = (data[0] << 16) | (data[1] << 8) | data[2];
    const type = data[3];
    const flags = data[4];
    const streamWord = uint32(data, 5);
    const reservedBit = ((streamWord >>> 31) & 0x1) as 0 | 1;
    const streamId = u31(streamWord);
    const payload = sliceBytes(data, FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + length);
    const frame: ParsedFrame = {
      id: `frm_${stableOf(materialStable, hunkIndex, order, hunk.rawHex)}`,
      order,
      direction: "c2s",
      hunkIndex,
      type,
      typeName: FRAME_TYPE_NAMES[type] ?? `UNKNOWN(0x${type.toString(16)})`,
      flags,
      streamId,
      reservedBit,
      payload,
    };
    if (data.length < FRAME_HEADER_LENGTH + length) {
      frame.truncated = FRAME_HEADER_LENGTH + length - data.length;
      diagnostics.push({
        hunkIndex,
        code: "TRUNCATED_PAYLOAD",
        message: `声明长度 ${length}，实际负载 ${payload.length}（缺 ${frame.truncated} 字节）；保留已到达字节。`,
      });
    } else if (data.length > FRAME_HEADER_LENGTH + length) {
      diagnostics.push({
        hunkIndex,
        code: "TRAILING_BYTES",
        message: `帧后多出 ${data.length - (FRAME_HEADER_LENGTH + length)} 字节，已忽略但保留原片段。`,
      });
    }
    frames.push(frame);
    order++;
  });
  return { frames, hunks, diagnostics };
}


import { fnv1a64 } from "./ids.ts";
function stableOf(...parts: (string | number)[]): string {
  return fnv1a64(parts.map((p) => String(p)).join(""));
}

export function frameHex(frame: ParsedFrame): string {
  return bytesToHex(concatBytes([buildFrame(frame.type, frame.flags, frame.streamId, frame.payload)]));
}

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) === flag;
}
