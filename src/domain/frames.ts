/** HTTP/2 帧层解析（RFC 7540 §4-§6）。只解析，不裁决；原字节始终保留。 */
import {
  FLAG_ACK,
  FLAG_END_HEADERS,
  FLAG_END_STREAM,
  FLAG_PADDED,
  FLAG_PRIORITY,
  FRAME_TYPES,
  type Direction,
  type FrameTypeName,
  type RawFrame,
} from "./types";
import { byteLength, q } from "./units";

export interface FrameInput {
  /** 原表示：十六进制帧字节（可含空白） */
  hex: string;
  direction: Direction;
  /** 该帧在原材料中的字节偏移（保留原表示） */
  sourceOffset?: number;
}

export interface ParsedFrame extends RawFrame {
  type: number;
  typeName: FrameTypeName | `UNKNOWN(${number})`;
  flags: number;
  streamId: number;
  payload: Buffer;
  reservedBit: number;
  diagnostics: string[];
}

export interface ParseOutcome {
  frames: ParsedFrame[];
  /** 无法成帧的残留/诊断，失败的片段留在原位，绝不静默丢弃 */
  leftovers: Array<{ offset: number; hex: string; diagnostic: string }>;
}

const HEADER_LEN = 9;

export function parseFrames(
  inputs: FrameInput[],
  idPrefix = "fr",
): ParseOutcome {
  const frames: ParsedFrame[] = [];
  const leftovers: ParseOutcome["leftovers"] = [];
  let offset = 0;
  let order = 0;

  for (const input of inputs) {
    const cleanHex = input.hex.replace(/\s+/g, "");
    const buf = Buffer.from(cleanHex, "hex");
    if (cleanHex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleanHex)) {
      leftovers.push({
        offset: input.sourceOffset ?? offset,
        hex: input.hex,
        diagnostic: "非十六进制/奇数长度，无法解析为帧字节，原样保留",
      });
      offset += Math.floor(cleanHex.length / 2);
      continue;
    }
    let cursor = 0;
    const frameStartOffset = input.sourceOffset ?? offset;
    while (buf.length - cursor >= HEADER_LEN) {
      const length = buf.readUInt24BE(cursor);
      const type = buf[cursor + 3];
      const flags = buf[cursor + 4];
      const sidWord = buf.readUInt32BE(cursor + 5);
      const reservedBit = (sidWord >>> 31) & 0x1;
      const streamId = sidWord & 0x7fffffff;
      const total = HEADER_LEN + length;
      if (buf.length - cursor < total) {
        leftovers.push({
          offset: frameStartOffset + cursor,
          hex: buf.subarray(cursor).toString("hex"),
          diagnostic: `帧头声明负载 ${length} 字节，但材料只剩 ${buf.length - cursor - HEADER_LEN} 字节，截断帧原样保留`,
        });
        cursor = buf.length;
        break;
      }
      const raw = buf.subarray(cursor, cursor + total);
      const payload = raw.subarray(HEADER_LEN);
      const diagnostics: string[] = [];
      const typeName = nameType(type);
      if (reservedBit !== 0)
        diagnostics.push("R 保留位非 0（RFC 7540 §4.1，连接错误 PROTOCOL_ERROR）");
      if (type === FRAME_TYPES.SETTINGS && streamId !== 0)
        diagnostics.push("SETTINGS 流标识必须为 0x0");
      if (type === FRAME_TYPES.SETTINGS && length % 6 !== 0)
        diagnostics.push("SETTINGS 负载长度必须为 6 字节的倍数");
      if (type !== FRAME_TYPES.SETTINGS && (flags & FLAG_ACK) !== 0)
        diagnostics.push("ACK 位只允许出现在 SETTINGS 帧");
      frames.push({
        frameId: `${idPrefix}-${order.toString().padStart(4, "0")}`,
        order,
        frameIndex: q(order, "frame_index", order),
        direction: input.direction,
        rawBytes: raw.toString("hex"),
        byteLength: byteLength(raw.toString("hex")),
        sourceOffset: q(frameStartOffset + cursor, "byte", frameStartOffset + cursor),
        type,
        typeName,
        flags,
        streamId,
        payload,
        reservedBit,
        diagnostics,
      });
      order += 1;
      cursor += total;
    }
    if (buf.length - cursor > 0 && cursor < HEADER_LEN) {
      leftovers.push({
        offset: frameStartOffset + cursor,
        hex: buf.subarray(cursor).toString("hex"),
        diagnostic: "不足 9 字节帧头，无法成帧，原样保留",
      });
    }
    offset += buf.length;
  }
  return { frames, leftovers };
}

function nameType(type: number): FrameTypeName | `UNKNOWN(${number})` {
  const found = (Object.entries(FRAME_TYPES).find(([, v]) => v === type)?.[0] ??
    null) as FrameTypeName | null;
  return found ?? `UNKNOWN(${type})`;
}

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

export const flagNames = (flags: number): string[] => {
  const names: string[] = [];
  if (flags & FLAG_END_STREAM) names.push("END_STREAM");
  if (flags & FLAG_ACK) names.push("ACK");
  if (flags & FLAG_END_HEADERS) names.push("END_HEADERS");
  if (flags & FLAG_PADDED) names.push("PADDED");
  if (flags & FLAG_PRIORITY) names.push("PRIORITY");
  return names;
};
