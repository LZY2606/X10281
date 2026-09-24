import type { TableSizeEffect } from "./settings.ts";

/**
 * 规则包：判断依据全部写成机器可读取事件（ReplayEvidence）。
 * v1 与 v1.1 结论一致，但引用坐标/注释修订，用于验证“参考版本变化后按
 * 依赖关系计算失效范围，而不是全局悄悄替换旧结论”。
 */
export interface RuleBundle {
  ruleVersion: string;
  releasedAt: string;
  title: string;
  citations: Record<string, { spec: "RFC9113" | "RFC7541"; section: string; text: string }>;
  defaults: {
    headerTableSizeEffect: Exclude<TableSizeEffect, "undetermined">;
    reservedBit: "protocol-error" | "ignore";
  };
}

export const RULE_BUNDLES: Record<string, RuleBundle> = {
  "rules-2026.0": {
    ruleVersion: "rules-2026.0",
    releasedAt: "2026-01-01",
    title: "HTTP/2/HPACK 基线规则（初版）",
    citations: {
      "RFC9113:4.2": { spec: "RFC9113", section: "4.2", text: "保留位 (R) 必须为 0；非 0 的帧必须以 PROTOCOL_ERROR 作为连接错误处理。" },
      "RFC9113:5.1.1": { spec: "RFC9113", section: "5.1.1", text: "新流标识符必须大于该端点已建立或预留的全部流标识符；否则 PROTOCOL_ERROR（连接错误）。" },
      "RFC9113:6.1": { spec: "RFC9113", section: "6.1", text: "PADDED 时 Pad Length 与填充超出剩余负载为 PROTOCOL_ERROR（连接错误）。" },
      "RFC9113:6.5": { spec: "RFC9113", section: "6.5", text: "SETTINGS 负载必须是 6 字节倍数；ACK 的 SETTINGS 负载必须为空。" },
      "RFC9113:6.5.1": { spec: "RFC9113", section: "6.5.1", text: "SETTINGS 帧的每个参数在被接收并确认时（receipt）生效；接收方回送 ACK。" },
      "RFC9113:8.2.1": { spec: "RFC9113", section: "8.2.1", text: "HEADERS(END_HEADERS=0) 之后若下一帧不是 CONTINUATION，为 PROTOCOL_ERROR（连接错误）。" },
      "RFC9113:4.3": { spec: "RFC9113", section: "4.3", text: "HPACK 解压缩错误必须以 COMPRESSION_ERROR 作为连接错误终止。" },
      "RFC7541:4.2": { spec: "RFC7541", section: "4.2", text: "动态表大小不得超过对端通过 SETTINGS_HEADER_TABLE_SIZE 允许的上界。" },
      "RFC9113:5.1": { spec: "RFC9113", section: "5.1", text: "stream 状态机：half-closed/closed 下的非法帧按状态表裁决，范围限定该流。" },
      "RFC9113:6.10": { spec: "RFC9113", section: "6.10", text: "CONTINUATION 只能紧跟 HEADERS/PUSH_PROMISE/CONTINUATION 链。" },
    },
    defaults: { headerTableSizeEffect: "receipt", reservedBit: "protocol-error" },
  },
  "rules-2026.1": {
    ruleVersion: "rules-2026.1",
    releasedAt: "2026-06-01",
    title: "HTTP/2/HPACK 规则（参考坐标修订，结论不变）",
    citations: {
      "RFC9113:4.2": { spec: "RFC9113", section: "4.2", text: "R 位语义保持：发送必须为 0，接收非 0 以 PROTOCOL_ERROR 连接错误处理。（文字修订）" },
      "RFC9113:5.1.1": { spec: "RFC9113", section: "5.1.1", text: "流标识符单调性与奇偶性；违反为连接级 PROTOCOL_ERROR。（补充穷尽复用说明）" },
      "RFC9113:6.1": { spec: "RFC9113", section: "6.1", text: "DATA padding 越界为连接级 PROTOCOL_ERROR。" },
      "RFC9113:6.5": { spec: "RFC9113", section: "6.5", text: "SETTINGS 负载 6 字节倍数；ACK SETTINGS 必须空负载、流 0。" },
      "RFC9113:6.5.1": { spec: "RFC9113", section: "6.5.1", text: "SETTINGS 参数在被接收时生效并回 ACK；ACK 不改变生效点。（引用修订）" },
      "RFC9113:8.2.1": { spec: "RFC9113", section: "8.2.1", text: "header block 片段必须连续，任何交错帧为连接级 PROTOCOL_ERROR。" },
      "RFC9113:4.3": { spec: "RFC9113", section: "4.3", text: "HPACK 压缩/解压缩错误为连接级 COMPRESSION_ERROR。" },
      "RFC7541:4.2": { spec: "RFC7541", section: "4.2", text: "Dynamic Table Size Update 不得超过对端允许值，否则解码错误（连接级）。" },
      "RFC9113:5.1": { spec: "RFC9113", section: "5.1", text: "流状态机裁决表；流错误范围限定单流（RST_STREAM）。" },
      "RFC9113:6.10": { spec: "RFC9113", section: "6.10", text: "CONTINUATION 链连续性与 END_HEADERS 结束。" },
    },
    defaults: { headerTableSizeEffect: "receipt", reservedBit: "protocol-error" },
  },
};

export const DEFAULT_RULE_VERSION = "rules-2026.0";
