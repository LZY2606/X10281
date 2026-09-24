/**
 * 领域量一律携带单位与坐标基准（value/unit/basis）。
 * 原始表示（如 rawHex）在导入层保留；本层只做派生规范化。
 */
export interface Quantity<V = number, U = string> {
  v: V;
  /** 单位，如 'byte' | 'frame-index' | 'stream-id' | 'byte-per-rfc7541-entry' */
  u: U;
  /** 坐标基准，如 'rfc7540-31bit' | 'wire-order' | 'per-direction-wire-offset' */
  b: string;
}

export const UNIT = {
  BYTE: 'byte',
  FRAME_INDEX: 'frame-index',
  STREAM_ID: 'stream-id',
  TABLE_SIZE_BYTES: 'byte-per-rfc7541-entry',
  COUNT: 'count',
  HEX_DIGIT: 'hex-digit',
} as const;

export const BASIS = {
  RFC7540_31BIT: 'rfc7540-31bit',
  WIRE_ORDER: 'wire-order',
  DIR_WIRE_OFFSET: 'per-direction-wire-offset',
  RFC7541_ENTRY: 'rfc7541-entry-size(32+nameBytes+valueBytes)',
  RFC7540_FRAME_HEADER: 'rfc7540-9-byte-frame-header',
} as const;

export function q(v: number, u: string, b: string): Quantity {
  return { v, u, b };
}

/** 保留原始表示的量；无法转换时 value 保持 null 并附诊断。 */
export interface RawQuantity {
  rawHex: string;
  normalized: Quantity | null;
  diagnosticCode: string | null;
}
