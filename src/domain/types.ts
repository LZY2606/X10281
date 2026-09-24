/**
 * 领域核心类型。
 * 原则：所有领域量都携带单位或坐标基准；导入时保留原始表示，派生层才做规范化。
 */

/** 连接方向：c2s = 客户端到服务器，s2c = 服务器到客户端。HPACK 动态表按方向隔离。 */
export type Direction = 'c2s' | 's2c';

export const oppositeDirection = (d: Direction): Direction => (d === 'c2s' ? 's2c' : 'c2s');

/** 带单位/坐标基准的领域量。raw 永远保留导入时的原始表示。 */
export interface Quantity {
  /** 原始表示（导入时原样保留，例如 "0x1f"、"64k"、"4096"） */
  raw: string;
  /** 规范化数值；无法转换时为 null，原值留在 raw 中并附 diagnostics */
  value: number | null;
  /** 单位或坐标基准，例如 'octet'、'frame-seq'、'rfc7540:stream-id:31bit' */
  unit: string;
  /** 规范化失败/存疑时的诊断信息；不为空表示该值不可用于派生计算 */
  diagnostics: string[];
}

export const qty = (raw: string, value: number | null, unit: string, diagnostics: string[] = []): Quantity => ({
  raw,
  value,
  unit,
  diagnostics,
});

/** 帧在连接时间线上的坐标：序号即时间基准（单位 frame-seq）。 */
export interface FrameCoord {
  seq: number; // 单调递增的帧序号
  unit: 'frame-seq';
}

export type FrameTypeName =
  | 'DATA' | 'HEADERS' | 'PRIORITY' | 'RST_STREAM' | 'SETTINGS'
  | 'PUSH_PROMISE' | 'PING' | 'GOAWAY' | 'WINDOW_UPDATE' | 'CONTINUATION' | 'UNKNOWN';

/** 原始帧：字节原样保留（hex），解析结果放派生层。 */
export interface RawFrame {
  /** 稳定身份：由材料内容哈希 + 帧序号决定，导出/重导入后不变 */
  id: string;
  materialId: string;
  direction: Direction;
  coord: FrameCoord;
  /** 原帧字节（含 9 字节帧头），十六进制，原样保留 */
  rawHex: string;
}

/** 派生层：解析后的帧头。 */
export interface FrameHeader {
  length: Quantity;   // 24-bit，单位 octet
  type: number;
  typeName: FrameTypeName;
  flags: number;
  streamId: Quantity; // 31-bit，坐标基准 rfc7540:stream-id:31bit
}

export type StreamState =
  | 'idle' | 'reserved-local' | 'reserved-remote'
  | 'open' | 'half-closed-local' | 'half-closed-remote' | 'closed';

export type ErrorScope = 'connection' | 'stream';

/** 协议违约 / 诊断记录。 */
export interface Violation {
  id: string;
  ruleId: string;          // 规则版本坐标，例如 'rfc7540:6.1:padding-overflow'
  scope: ErrorScope;
  frameId: string | null;  // 触发帧
  streamId: number | null; // stream 错误时归属的流
  message: string;
  /** 受影响对象（稳定身份列表），用于检验影响是否被限制在正确范围 */
  affected: string[];
}

/** HPACK 动态表的一个版本（按方向隔离）。 */
export interface DynamicTableVersion {
  id: string;
  direction: Direction;
  version: number;
  entries: Array<{ name: string; value: string; size: Quantity }>;
  size: Quantity;     // 当前占用，单位 octet
  maxSize: Quantity;  // 上限，单位 octet；SETTINGS 确认前后不混用
  causedBy: string;   // 造成该版本的帧/事件 id
}

/** 解码出的 header 及其来源链。 */
export interface DecodedHeader {
  id: string;
  name: string;
  value: string;
  /** 来源：静态表 / 动态表（含表版本）/ 字面量 */
  source:
    | { kind: 'static-table'; index: number }
    | { kind: 'dynamic-table'; index: number; tableVersionId: string }
    | { kind: 'literal'; nameSource?: { kind: 'static-table' | 'dynamic-table'; index: number } };
}

export interface HeaderBlock {
  id: string;
  streamId: number;
  direction: Direction;
  /** CONTINUATION 链：组成该 header block 的全部帧 id，按序 */
  fragmentFrameIds: string[];
  headers: DecodedHeader[];
  /** 解码所用动态表版本（解码完成时刻） */
  tableVersionId: string;
  /** 解码歧义时的全部合法候选 */
  candidates: HeaderBlockCandidate[];
}

export interface HeaderBlockCandidate {
  id: string;
  label: string;
  headers: DecodedHeader[];
  tableVersionId: string;
  rationale: string;
}
