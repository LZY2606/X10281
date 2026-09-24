/**
 * 领域量单位与坐标基准。
 * 原始导入层保留原表示（raw + unit/basis），派生层才做规范化。
 */

export type Unit =
  | "byte" // 字节
  | "octet" // HPACK RFC 7541 用词 octet
  | "frame_index" // 帧序号（从 0 开始，连接方向轴坐标）
  | "stream_id" // HTTP/2 流标识（无符号 31 位）
  | "table_index" // HPACK 表位置（1 基，静态表 1..61，动态表紧随其后）
  | "dynamic_slot" // 动态表槽位（1 基，最新插入为 1）
  | "setting_id" // SETTINGS 参数标识
  | "direction" // 连接方向轴：client->server / server->client
  | "table_version" // 动态表单调版本号
  | "branch_seq" // 分支内事件序号
  | "error_scope"; // 错误范围：connection / stream

export interface Quantified<V = string | number> {
  /** 原始表示，永远保留，不做不可逆清洗 */
  raw: V;
  /** 该量的单位或坐标基准 */
  unit: Unit;
  /** 派生层规范化结果（原始值无法转换时为 null） */
  normalized?: number | null;
  /** 无法转换/无法唯一决定时的诊断 */
  diagnostic?: string;
}

export function q(
  raw: string | number,
  unit: Unit,
  normalized?: number | null,
  diagnostic?: string,
): Quantified {
  return { raw, unit, normalized: normalized ?? null, diagnostic };
}

/** 字节长度规范化（原始表示可能是十六进制串） */
export function byteLength(raw: string): Quantified<string> {
  const hex = raw.replace(/\s+/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return {
      raw,
      unit: "byte",
      normalized: null,
      diagnostic: "不是偶数长度的十六进制字节串，无法规范化字节长度",
    };
  }
  return { raw, unit: "byte", normalized: hex.length / 2 };
}
