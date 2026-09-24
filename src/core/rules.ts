// 机器可读的判断依据：每条规则有稳定 ruleId / 版本 / RFC 坐标。
// replay 产生的每个 finding 都引用 ruleId+version，参数修订只替换规则版本，
// 依赖图据此计算失效范围，不做全局静默替换。

export type ViolationScope = 'connection' | 'stream';

export interface RuleDef {
  ruleId: string;
  version: number;
  title: string;
  rfcRef: string;
  scope: ViolationScope | 'conditional';
  errorCode: number;
  /** 单位或坐标基准（领域量必须自描述） */
  units: string;
  /** 失效影响标签：参数修订时按标签计算受影响 finding */
  affects: string[];
}

export const RULE_PACK_ID = 'hpack-state-mirror-rules';
export const DEFAULT_RULE_PACK_VERSION = 1;

export const RULE_PACKS: Record<number, Record<string, RuleDef>> = {
  1: {
    'R-HPACK-INDEX': {
      ruleId: 'R-HPACK-INDEX', version: 1, title: 'HPACK 索引必须落在当前方向静态/动态表范围内',
      rfcRef: 'RFC 7541 §6.1 / RFC 7540 §8.1.2.6', scope: 'connection', errorCode: 0x9,
      units: '1-based table index', affects: ['hpack', 'header-block'],
    },
    'R-HPACK-DIRECTION': {
      ruleId: 'R-HPACK-DIRECTION', version: 1, title: 'HPACK 动态表按连接方向隔离，禁止跨方向引用',
      rfcRef: 'RFC 7540 §6.5.2', scope: 'connection', errorCode: 0x9,
      units: 'direction ∈ {c2s,s2c}', affects: ['hpack', 'direction'],
    },
    'R-HPACK-SIZE-LIMIT': {
      ruleId: 'R-HPACK-SIZE-LIMIT', version: 1, title: '动态表尺寸更新不得超过当前生效的 SETTINGS_HEADER_TABLE_SIZE',
      rfcRef: 'RFC 7541 §4.2 / RFC 7540 §6.5.2', scope: 'connection', errorCode: 0x9,
      units: 'octets', affects: ['hpack', 'settings'],
    },
    'R-SETTINGS-ACK': {
      ruleId: 'R-SETTINGS-ACK', version: 1, title: 'SETTINGS ACK 只能对应已收到的非 ACK SETTINGS；新上限在 ACK 生效点后才被发送方采用',
      rfcRef: 'RFC 7540 §6.5.3', scope: 'connection', errorCode: 0x1,
      units: 'settings exchange sequence ordinal', affects: ['settings', 'hpack'],
    },
    'R-HEADERBLOCK-CONTIGUITY': {
      ruleId: 'R-HEADERBLOCK-CONTIGUITY', version: 1, title: 'HEADERS 与 CONTINUATION 链之间不得出现任何其他帧',
      rfcRef: 'RFC 7540 §8.1.2 / §6.10', scope: 'connection', errorCode: 0x1,
      units: 'frame sequence ordinal', affects: ['header-block', 'continuity'],
    },
    'R-CONTINUATION-STREAM': {
      ruleId: 'R-CONTINUATION-STREAM', version: 1, title: 'CONTINUATION 必须延续同一 stream 上处于打开状态的 header block',
      rfcRef: 'RFC 7540 §6.10', scope: 'connection', errorCode: 0x1,
      units: 'stream id', affects: ['header-block'],
    },
    'R-PADDING': {
      ruleId: 'R-PADDING', version: 1, title: 'PADDED 长度不得使填充越界（pad length 超过载荷可容纳范围）',
      rfcRef: 'RFC 7540 §6.1 / §6.2', scope: 'connection', errorCode: 0x1,
      units: 'octets', affects: ['padding'],
    },
    'R-STREAM-EXHAUST': {
      ruleId: 'R-STREAM-EXHAUST', version: 1, title: 'stream id 不得超过 2^31-1；R 位必须为 0；耗尽后以 ENHANCE_YOUR_CALM 关连接',
      rfcRef: 'RFC 7540 §5.1.1 / §5.4.2', scope: 'connection', errorCode: 0xb,
      units: '31-bit stream identifier', affects: ['stream-id'],
    },
    'R-STREAM-REUSE': {
      ruleId: 'R-STREAM-REUSE', version: 1, title: '已关闭的 stream id 不得再承载 HEADERS/RST_STREAM 等非法帧',
      rfcRef: 'RFC 7540 §5.1.1', scope: 'stream', errorCode: 0x5,
      units: 'stream id + state', affects: ['stream', 'stream-id'],
    },
    'R-HALF-CLOSED-DIRECTION': {
      ruleId: 'R-HALF-CLOSED-DIRECTION', version: 1, title: '半关闭状态下按方向表裁决帧合法性：本端 half-closed(local) 禁止再发 HEADERS/DATA(END_STREAM)',
      rfcRef: 'RFC 7540 §5.1', scope: 'stream', errorCode: 0x5,
      units: 'stream state + direction', affects: ['stream', 'direction'],
    },
    'R-STREAM-IDENTIFIER-ZERO': {
      ruleId: 'R-STREAM-IDENTIFIER-ZERO', version: 1, title: '仅连接级帧允许 stream id 0；stream 帧置 0 为连接错误',
      rfcRef: 'RFC 7540 §6', scope: 'connection', errorCode: 0x1,
      units: 'stream id', affects: ['stream-id'],
    },
  } as Record<string, RuleDef>,
};

/** 一次参数修订（规则包 v2）：仅 HPACK 上限相关规则升版，演示局部失效 */
export const REVISED_RULE_PACK_VERSION = 2;
RULE_PACKS[2] = {
  ...RULE_PACKS[1]!,
  'R-HPACK-SIZE-LIMIT': { ...RULE_PACKS[1]!['R-HPACK-SIZE-LIMIT']!, version: 2, title: '动态表尺寸更新不得超过当前生效的 SETTINGS_HEADER_TABLE_SIZE（v2：ACK 前后候选全部显式保留）' },
  'R-HPACK-INDEX': RULE_PACKS[1]!['R-HPACK-INDEX']!,
};

export function getRule(ruleId: string, version: number = DEFAULT_RULE_PACK_VERSION): RuleDef {
  const pack = RULE_PACKS[version] ?? RULE_PACKS[DEFAULT_RULE_PACK_VERSION]!;
  return pack[ruleId] ?? RULE_PACKS[1]![ruleId]!;
}
