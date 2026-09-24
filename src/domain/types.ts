/** HTTP/2 / HPACK / 流状态回放器的领域类型 */
import type { Quantified } from "./units";

export type Direction = "client->server" | "server->client";

export const FRAME_TYPES = {
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
export type FrameTypeName = keyof typeof FRAME_TYPES;

export const FLAG_ACK = 0x1;
export const FLAG_END_STREAM = 0x1;
export const FLAG_END_HEADERS = 0x4;
export const FLAG_PADDED = 0x8;
export const FLAG_PRIORITY = 0x20;

/** 原始帧：原始字节按原表示保留 */
export interface RawFrame {
  /** 材料内稳定身份 */
  frameId: string;
  /** 全局连接轴上的序号（0 基），由解析顺序给出，也是时间线坐标 */
  order: number;
  /** 时间线坐标，单位 frame_index */
  frameIndex: Quantified<number>;
  /** 连接方向 */
  direction: Direction;
  /** 原帧字节（含 9 字节帧头），十六进制原表示 */
  rawBytes: string;
  /** 该帧字节的字节量（保留原始表示） */
  byteLength: Quantified<string>;
  /** 来源材料坐标：该帧在原文件/原片段中的偏移（字节），保留原表示 */
  sourceOffset: Quantified<number>;
}

export type HeaderValueRepr = "literal" | "indexed" | "never" | "incremental";

export interface HeaderSource {
  /** 稳定身份：frameId#block 内片段序号 */
  headerId: string;
  /** HPACK 表示方式 */
  repr: HeaderValueRepr;
  /** 引用的表位置（1 基）；literal-without-indexing 可为 null */
  tableIndex: Quantified<number> | null;
  /** 解析出的 name（原始字节→utf8；无法转换时留在原位） */
  name: string | Quantified<string>;
  value: string | Quantified<string>;
  /** 该 header 引用的动态表版本 */
  tableVersion: Quantified<number> | null;
  /** 若来自动态表，记录槽位，便于反查插入帧 */
  dynamicSlot: Quantified<number> | null;
}

/** 一个 header block 跨 HEADERS/CONTINUATION 链的聚合 */
export interface HeaderBlock {
  blockId: string;
  /** 链头帧（HEADERS/PUSH_PROMISE） */
  headFrameId: string;
  /** CONTINUATION 链，按连接轴排序；空数组表示头帧自带 END_HEADERS */
  continuationFrameIds: string[];
  streamId: number;
  direction: Direction;
  complete: boolean;
  /** 未完整时的诊断 */
  diagnostic?: string;
  headers: HeaderSource[];
  /** 链尾帧的 frameIndex（未完时为链中最后一帧） */
  endFrameIndex: number;
}

export type ErrorScope = "connection" | "stream";

export interface ProtocolViolation {
  violationId: string;
  frameId: string;
  frameIndex: number;
  direction: Direction;
  /** 错误码名称（RFC 7540 §11.4） */
  errorCode:
    | "PROTOCOL_ERROR"
    | "COMPRESSION_ERROR"
    | "FRAME_SIZE_ERROR"
    | "PROTOCOL_ERROR?STREAM_CLOSED"
    | "REFUSED_STREAM"
    | "ENHANCE_YOUR_CALM"
    | "INTERNAL_ERROR";
  scope: ErrorScope;
  /** stream 错误时的目标流；连接错误为 null */
  streamId: number | null;
  ruleId: string;
  message: string;
}

export type StreamStateName =
  | "idle"
  | "open"
  | "half-closed(local)"
  | "half-closed(remote)"
  | "closed"
  | "reserved(local)"
  | "reserved(remote)";

export interface StreamStateSnapshot {
  streamId: number;
  state: StreamStateName;
  /** 进入该状态的帧坐标 */
  sinceFrameIndex: number;
  /** 由谁的视角决定 local/remote（连接方向轴） */
  initiatedBy: Direction | null;
}

/** SETTINGS 生效点：确认前/确认后两个区间不混用 */
export interface SettingsEffectPoint {
  /** 稳定身份：方向 + 帧坐标 */
  pointId: string;
  frameId: string;
  frameIndex: number;
  direction: Direction;
  /** 对端 SETTINGS 帧到达点：新值对本端“待生效” */
  phase: "received" | "acknowledged";
  /** 生效后的 HEADER_TABLE_SIZE（octet），未提供则沿用默认 4096 */
  headerTableSize: number;
  /** MAX_CONCURRENT_STREAMS，未提供为 null（不限） */
  maxConcurrentStreams: number | null;
}

export interface TableEntry {
  /** 稳定身份：方向#版本#槽位 */
  entryId: string;
  name: string;
  value: string;
  /** 插入时的表版本（该插入之后的版本） */
  insertedAtVersion: number;
  /** 插入来源帧，便于反查原字节 */
  insertedByFrameId: string;
  size: number;
}

/** 某一帧处理后、某方向的动态表版本快照 */
export interface TableVersionSnapshot {
  versionId: string;
  direction: Direction;
  version: number;
  frameIndex: number;
  /** 当前表占用（octet），以 RFC7541 4.1 计算 */
  size: number;
  /** 上限：取“已确认”的 SETTINGS_HEADER_TABLE_SIZE，确认前后不混用 */
  capacity: number;
  entries: TableEntry[];
}

/** 逐帧重建产物（一个解释候选的完整结果） */
export interface ReplayResult {
  candidateId: string;
  frames: RawFrame[];
  headerBlocks: HeaderBlock[];
  violations: ProtocolViolation[];
  streamSnapshots: Array<{ frameIndex: number; streams: StreamStateSnapshot[] }>;
  tableVersions: TableVersionSnapshot[];
  settingsPoints: SettingsEffectPoint[];
  /** 被最早连接错误/致命流错误中止处理的帧坐标（之后帧不再裁决） */
  haltAfterFrameIndex: number | null;
  diagnostics: string[];
}

/** 多候选：无法唯一决定时保留全部合法候选 */
export interface InterpretationCandidate {
  candidateId: string;
  label: string;
  assumptionRuleId: string;
  replay: ReplayResult;
}
