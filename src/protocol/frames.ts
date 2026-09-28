import { FRAME_FLAG, FRAME_TYPE_BY_CODE } from "./types.ts";
import type { Direction, FrameType, ParsedFrame } from "./types.ts";
import { bytesToHex, hexToBytes } from "./hpack.ts";

export class FrameParseError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "FrameParseError";
  }
}

const FRAME_HEADER_LEN = 9;
const MAX_FRAME_LEN = 16 * 1024 * 1024;

export interface ParseStreamResult {
  frames: ParsedFrame[];
  /** 无法解析时：剩余的原字节诊断，原始字节本身不丢。 */
  trailingHex?: string;
  diagnostic?: string;
}

/** 从原始字节流逐帧解析；解析失败的帧之后的字节原样保留为 trailingHex。 */
export function parseFrameStream(direction: Direction, hex: string, idPrefix: string): ParseStreamResult {
  const buf = hexToBytes(hex);
  const frames: ParsedFrame[] = [];
  let offset = 0;
  let seq = 0;
  while (offset < buf.length) {
    const frameStart = offset;
    if (buf.length - offset < FRAME_HEADER_LEN) {
      return {
        frames,
        trailingHex: bytesToHex(buf.slice(offset)),
        diagnostic: "残帧：不足 9 字节帧头，原字节保留在末尾",
      };
    }
    const length = (buf[offset]! << 16) | (buf[offset + 1]! << 8) | buf[offset + 2]!;
    const typeCode = buf[offset + 3]!;
    const flags = buf[offset + 4]!;
    const idWord = (buf[offset + 5]! << 24) | (buf[offset + 6]! << 16) | (buf[offset + 7]! << 8) | buf[offset + 8]!;
    const reservedBit = ((idWord & 0x80000000) >>> 31) as 0 | 1;
    const streamId = idWord & 0x7fffffff;
    offset += FRAME_HEADER_LEN;
    if (length > MAX_FRAME_LEN) {
      return {
        frames,
        trailingHex: bytesToHex(buf.slice(frameStart)),
        diagnostic: `帧声明长度 ${length} 超过 16MiB 上限，原字节保留`,
      };
    }
    if (offset + length > buf.length) {
      return {
        frames,
        trailingHex: bytesToHex(buf.slice(frameStart)),
        diagnostic: `帧声明长度 ${length} 但仅剩 ${buf.length - offset} 字节，截断帧原字节保留`,
      };
    }
    const payload = buf.slice(offset, offset + length);
    offset += length;
    const type = (FRAME_TYPE_BY_CODE[typeCode] ?? "UNKNOWN") as FrameType;
    const frameId = `${idPrefix}f${seq.toString().padStart(3, "0")}`;

    const parsed: ParsedFrame = {
      frameId,
      seq,
      length,
      type,
      typeCode,
      flags,
      streamId,
      reservedBit,
      payloadHex: bytesToHex(payload),
      direction,
      ack: false,
    };

    try {
      decorate(parsed, payload);
    } catch (err) {
      parsed.diagnostic = err instanceof Error ? err.message : String(err);
    }
    frames.push(parsed);
    seq += 1;
  }
  return { frames };
}

function decorate(f: ParsedFrame, p: Uint8Array): void {
  const flags = f.flags;
  switch (f.type) {
    case "HEADERS":
    case "PUSH_PROMISE": {
      let i = 0;
      if (flags & FRAME_FLAG.PADDED) {
        if (p.length < 1) throw new FrameParseError("PADLEN_MISSING", "PADDED 帧缺少 Pad Length");
        f.padLength = p[0]!;
        i = 1;
      }
      if (f.type === "HEADERS" && flags & FRAME_FLAG.PRIORITY) {
        if (p.length < i + 5) throw new FrameParseError("PRIORITY_TRUNCATED", "PRIORITY 信息被截断");
        const depWord = (p[i]! << 24) | (p[i + 1]! << 16) | (p[i + 2]! << 8) | p[i + 3]!;
        f.priority = {
          exclusive: (p[i]! & 0x80) !== 0,
          streamDep: depWord & 0x7fffffff,
          weight: p[i + 4]! + 1,
        };
        i += 5;
      }
      if (f.type === "PUSH_PROMISE") {
        if (p.length < i + 4) throw new FrameParseError("PUSH_TRUNCATED", "PUSH_PROMISE 缺少 Promised Stream ID");
        i += 4;
      }
      // padding 越界：fragment 长度 <= 0 即“pad 把整个 payload 吃光或更多”。
      const dataLen = p.length - i;
      const pad = f.padLength ?? 0;
      f.paddingBytes = pad;
      if (pad > dataLen) {
        f.diagnostic = `padding 越界：Pad Length ${pad} > 剩余 ${dataLen} 字节（含 fragment 前必须剩数据）`;
        f.headerBlockHex = "";
      } else if (pad === dataLen) {
        f.diagnostic = `padding 越界：Pad Length ${pad} 恰好吃光 ${dataLen} 字节，header fragment 为空`;
        f.headerBlockHex = "";
      } else {
        f.headerBlockHex = bytesToHex(p.slice(i, p.length - pad));
      }
      break;
    }
    case "DATA": {
      let i = 0;
      if (flags & FRAME_FLAG.PADDED) {
        if (p.length < 1) throw new FrameParseError("PADLEN_MISSING", "PADDED DATA 缺少 Pad Length");
        f.padLength = p[0]!;
        i = 1;
      }
      const dataLen = p.length - i;
      f.paddingBytes = f.padLength ?? 0;
      if ((f.padLength ?? 0) > dataLen) {
        f.diagnostic = `padding 越界：Pad Length ${f.padLength} > 剩余 ${dataLen} 字节`;
      }
      break;
    }
    case "SETTINGS": {
      f.ack = (flags & FRAME_FLAG.ACK) !== 0;
      if (!f.ack) {
        if (p.length % 6 !== 0) f.diagnostic = `SETTINGS payload ${p.length} 字节不是 6 的倍数`;
        const settings: Array<{ id: number; value: bigint }> = [];
        for (let i = 0; i + 6 <= p.length; i += 6) {
          const id = (p[i]! << 8) | p[i + 1]!;
          const value =
            (BigInt(p[i + 2]!) << 24n) |
            (BigInt(p[i + 3]!) << 16n) |
            (BigInt(p[i + 4]!) << 8n) |
            BigInt(p[i + 5]!);
          settings.push({ id, value });
        }
        f.settings = settings;
      }
      break;
    }
    case "WINDOW_UPDATE": {
      if (p.length !== 4) f.diagnostic = `WINDOW_UPDATE payload 应为 4 字节，实际 ${p.length}`;
      break;
    }
    case "PING": {
      if (p.length !== 8) f.diagnostic = `PING opaque data 应为 8 字节，实际 ${p.length}`;
      break;
    }
    case "GOAWAY": {
      if (p.length < 8) f.diagnostic = `GOAWAY payload 至少 8 字节，实际 ${p.length}`;
      break;
    }
    default:
      break;
  }
}

/* -------------------------------- 帧构造器 -------------------------------- */

export interface FrameBuildOptions {
  type: number;
  flags?: number;
  streamId?: number;
  payload?: number[];
  reservedBit?: 0 | 1;
}

export function buildFrame(opts: FrameBuildOptions): Uint8Array {
  const payload = opts.payload ?? [];
  const out = new Uint8Array(FRAME_HEADER_LEN + payload.length);
  const len = payload.length;
  out[0] = (len >> 16) & 0xff;
  out[1] = (len >> 8) & 0xff;
  out[2] = len & 0xff;
  out[3] = opts.type;
  out[4] = opts.flags ?? 0;
  const sid = (opts.streamId ?? 0) & 0x7fffffff;
  out[5] = ((sid >>> 24) & 0xff) | ((opts.reservedBit ?? 0) << 7);
  out[6] = (sid >>> 16) & 0xff;
  out[7] = (sid >>> 8) & 0xff;
  out[8] = sid & 0xff;
  out.set(payload, FRAME_HEADER_LEN);
  return out;
}

export function concatFrames(...frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}

export const FRAME_CODES = {
  DATA: 0,
  HEADERS: 1,
  PRIORITY: 2,
  RST_STREAM: 3,
  SETTINGS: 4,
  PUSH_PROMISE: 5,
  PING: 6,
  GOAWAY: 7,
  WINDOW_UPDATE: 8,
  CONTINUATION: 9,
} as const;
