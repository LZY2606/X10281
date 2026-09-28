/** 连接方向：方向是一个坐标基准。帧总是沿某一方向流动。 */
export type Direction = "c2s" | "s2c";

export const DIRECTIONS: readonly Direction[] = ["c2s", "s2c"] as const;

/** 带坐标基准的领域量：导入时保留 raw（原始表示），规范化结果放在 normalized。 */
export interface Dimensioned<T> {
  raw: string;
  basis: string;
  normalized?: T;
  unit?: string;
}

/** RFC 7541 静态表条目。 */
export interface StaticEntry {
  name: string;
  value: string;
}

export interface DynamicTableEntry {
  name: string;
  value: string;
  insertedAtFrameId: string;
  evictedAtFrameId?: string;
}

/** HPACK 解码出的一个 header 字段。 */
export interface HeaderField {
  name: string;
  value: string;
  representation:
    | "indexed"
    | "literal-incremental"
    | "literal-without-indexing"
    | "literal-never-indexed"
    | "dynamic-size-update"
    | "unknown";
  /** 解析该字段引用的 HPACK 索引（1-based，跨静态/动态表），无法确定时为 null。 */
  hpackIndex: number | null;
  /** 该字段在 header block 内的序号（0-based）。 */
  ordinal: number;
  rawHex: string;
  diagnostic?: string;
}

export type FrameType =
  | "DATA"
  | "HEADERS"
  | "PRIORITY"
  | "RST_STREAM"
  | "SETTINGS"
  | "PUSH_PROMISE"
  | "PING"
  | "GOAWAY"
  | "WINDOW_UPDATE"
  | "CONTINUATION"
  | "UNKNOWN";

export const FRAME_TYPE_BY_CODE: Record<number, FrameType> = {
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

export const FRAME_FLAG = {
  END_STREAM: 0x1,
  ACK: 0x1,
  END_HEADERS: 0x4,
  PADDED: 0x8,
  PRIORITY: 0x20,
} as const;

/** 已解析的 HTTP/2 帧（解释层），原始字节仍在 source 层独立保存。 */
export interface ParsedFrame {
  frameId: string;
  seq: number;
  length: number;
  type: FrameType;
  typeCode: number;
  flags: number;
  streamId: number;
  reservedBit: 0 | 1;
  payloadHex: string;
  direction: Direction;
  padLength?: number;
  paddingBytes?: number;
  /** HEADERS/PUSH_PROMISE/CONTINUATION 的 header block fragment 十六进制。 */
  headerBlockHex?: string;
  /** PRIORITY 信息。 */
  priority?: { exclusive: boolean; streamDep: number; weight: number };
  settings?: Array<{ id: number; value: bigint }>;
  ack: boolean;
  diagnostic?: string;
}

export type StreamState =
  | "idle"
  | "reserved-local"
  | "reserved-remote"
  | "open"
  | "half-closed-remote"
  | "half-closed-local"
  | "closed";

export type ErrorScope = "connection" | "stream" | "diagnostic";

export interface Violation {
  code: string;
  scope: ErrorScope;
  /** 触发帧（稳定 frameId）。 */
  frameId: string;
  streamId: number | null;
  message: string;
  /** 机器可读的判断依据。 */
  basis: JudgmentBasis;
  /** 当协议规则下存在多种合法裁决时，本条违规来自某个候选。 */
  candidateId?: string;
}

/** 判断依据：机器可读事件，支撑复核界面的“为什么”。 */
export interface JudgmentBasis {
  ruleId: string;
  ruleVersion: string;
  section: string;
  direction: Direction;
  /** 关联对象（动态表版本、setting、前驱 frameId 等）。 */
  refs: Record<string, string>;
  fact: string;
  /** 该结论依赖的派生来源（用于失效范围计算）。 */
  dependsOn: string[];
}
