import type { Direction } from "./frames.ts";

/**
 * SETTINGS 生效点模型（RFC 9113 §6.5.1 / RFC 7541 §4.2）。
 *
 * 接收方收到带 ACK 标志以外的 SETTINGS 帧时，参数立即生效，并回 ACK。
 * 因此 SETTINGS_HEADER_TABLE_SIZE 对“发送方编码器”的约束在对端收到 SETTINGS
 * 时生效；“收到 ACK 后才生效”是常见的错误实现/错误叙述。本回放器将生效点
 * 显式记录成事件，并保留多候选：
 *   - receipt：对端收到 SETTINGS 即生效（RFC 基线）
 *   - ack：发送方收到 ACK 才生效（被保留的错误候选，可被人工否定）
 *   - undetermined：两个候选都保留，等审阅者裁定
 */
export type TableSizeEffect = "receipt" | "ack" | "undetermined";

export const SETTINGS_PARAM_NAMES: Record<number, string> = {
  1: "HEADER_TABLE_SIZE",
  2: "ENABLE_PUSH",
  3: "MAX_CONCURRENT_STREAMS",
  4: "INITIAL_WINDOW_SIZE",
  5: "MAX_FRAME_SIZE",
  6: "MAX_HEADER_LIST_SIZE",
  7: "ENABLE_CONNECT_PROTOCOL",
};

export interface SettingAckPoint {
  frameId: string;
  order: number;
  direction: Direction;
  acknowledgedFrameId?: string;
  isAck: boolean;
}

export interface SettingsChange {
  frameId: string;
  order: number;
  direction: Direction;
  /** 该 SETTINGS 帧由该方向发出；约束的是该方向发送端的编码器。 */
  params: { id: number; name: string; value: number; unit: "octets" | "boolean" | "streams" | "dimensionless" }[];
  /** 生效点规则下，这个变更对哪个方向的“编码上限”生效，生效于第几帧。 */
  effectiveAtOrder: number;
  ackFrameId?: string;
}

export function decodeSettingsPayload(payload: number[]): {
  params: SettingsChange["params"];
  error?: { code: string; message: string };
} {
  if (payload.length % 6 !== 0) {
    return {
      params: [],
      error: { code: "SETTINGS_FRAME_SIZE_ERROR", message: `SETTINGS 负载长度 ${payload.length} 不是 6 的倍数（RFC 9113 §6.5）` },
    };
  }
  const params: SettingsChange["params"] = [];
  for (let i = 0; i < payload.length; i += 6) {
    const id = (payload[i] << 8) | payload[i + 1];
    const value =
      payload[i + 2] * 0x1000000 + payload[i + 3] * 0x10000 + payload[i + 4] * 0x100 + payload[i + 5];
    const units: Record<number, "octets" | "boolean" | "streams" | "dimensionless"> = {
      1: "octets",
      2: "boolean",
      3: "streams",
      4: "octets",
      5: "octets",
      6: "octets",
      7: "boolean",
    };
    params.push({ id, name: SETTINGS_PARAM_NAMES[id] ?? `UNKNOWN(${id})`, value, unit: units[id] ?? "dimensionless" });
  }
  return { params };
}
