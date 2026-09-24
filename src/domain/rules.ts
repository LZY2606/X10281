/**
 * 推导规则注册表：每条规则带稳定 id、版本与机器可读判断依据。
 * 规则版本变化即产生新的派生代次，旧结论保留不覆盖。
 */
export interface RuleSpec {
  id: string;
  version: string;
  summary: string;
  /** 机器可读判断依据 */
  basis: Record<string, unknown>;
}

export const RULESET_ID = 'rfc7540-7541-mirror';

export const RULES: Record<string, RuleSpec> = {
  HPACK_DIRECTION_ISOLATION: {
    id: 'HPACK_DIRECTION_ISOLATION',
    version: 'v1',
    summary: 'HPACK 动态表按连接方向隔离，两个方向的索引空间互不可见',
    basis: {
      tables: ['tbl-c2s', 'tbl-s2c'],
      isolation: 'per-direction',
      crossDirectionIndexVisible: false,
      ambiguousDirectionPolicy: 'emit-candidates-for-each-direction',
    },
  },
  HPACK_SETTINGS_PHASE_LIMIT: {
    id: 'HPACK_SETTINGS_PHASE_LIMIT',
    version: 'v1',
    summary: '动态表大小更新的上限取 SETTINGS 确认相位对应的值，确认前后上限不混用',
    basis: {
      capSource: 'peer SETTINGS_HEADER_TABLE_SIZE',
      effectivePointParam: 'settingsEffectivePoint(on-receipt|on-ack)',
      preAckCap: 'last value effective before ACK',
      postAckCap: 'value effective after ACK',
      mixingForbidden: true,
      violation: 'DYNAMIC_TABLE_SIZE_UPDATE_EXCEEDS(connection, COMPRESSION_ERROR)',
    },
  },
  H2_HEADER_BLOCK_EXCLUSIVITY: {
    id: 'H2_HEADER_BLOCK_EXCLUSIVITY',
    version: 'v1',
    summary: 'header block 未完成（HEADERS/CONTINUATION 链未闭合）时，其他帧按协议裁决',
    basis: {
      openChain: 'HEADERS without END_HEADERS opens a continuation chain',
      interleavedFrame: 'INTERLEAVED_HEADER_BLOCK(connection, PROTOCOL_ERROR)',
      wrongStreamContinuation: 'CONTINUATION_WRONG_STREAM(connection, PROTOCOL_ERROR)',
      orphanContinuation: 'CONTINUATION_WITHOUT_HEADERS(connection, PROTOCOL_ERROR)',
    },
  },
  H2_ERROR_SCOPE_SEPARATION: {
    id: 'H2_ERROR_SCOPE_SEPARATION',
    version: 'v1',
    summary: '连接错误与 stream 错误分开记录，互不升格',
    basis: {
      connectionErrors: [
        'INTERLEAVED_HEADER_BLOCK',
        'PADDING_OUT_OF_BOUNDS',
        'SETTINGS_ACK_WITH_PAYLOAD',
        'SETTINGS_ACK_WITHOUT_PENDING',
        'SETTINGS_ON_STREAM',
        'INDEX_OUT_OF_BOUNDS',
        'DYNAMIC_TABLE_SIZE_UPDATE_EXCEEDS',
        'STREAM_ID_EXHAUSTED',
        'STREAM_ID_PARITY',
        'STREAM_ID_ZERO',
        'IDLE_STREAM_FRAME',
      ],
      streamErrors: ['STREAM_CLOSED_ON_HALF_CLOSED'],
      note: '连接错误不终止回放（分析模式），但 HPACK 解码器在索引类错误后按方向停摆',
    },
  },
  HPACK_INDEX_BOUNDS: {
    id: 'HPACK_INDEX_BOUNDS',
    version: 'v1',
    summary: 'HPACK 索引必须落在 static(1..61)+dynamic 范围内，越界为该方向的连接错误',
    basis: {
      validRange: '1..staticTable.length+dynamicTable.length',
      indexZero: 'HPACK_INDEX_ZERO(connection, COMPRESSION_ERROR)',
      outOfBounds: 'INDEX_OUT_OF_BOUNDS(connection, COMPRESSION_ERROR)',
      decoderAfter: 'halted for that direction; later blocks keep raw bytes with diagnostic',
    },
  },
  H2_PADDING_BOUNDS: {
    id: 'H2_PADDING_BOUNDS',
    version: 'v1',
    summary: 'DATA/HEADERS 的 Pad Length 不得超过剩余负载长度',
    basis: {
      check: 'padLength <= payloadLength - padLengthFieldBytes',
      violation: 'PADDING_OUT_OF_BOUNDS(connection, PROTOCOL_ERROR)',
      rawPreserved: true,
    },
  },
  H2_STREAM_ID_SPACE: {
    id: 'H2_STREAM_ID_SPACE',
    version: 'v1',
    summary: 'stream id 为 31 位空间，保留位置位或触及 2^31-1 上限即空间穷尽',
    basis: {
      space: '31-bit unsigned, client odd / server even',
      exhausted: 'reserved bit set or value == 0x7fffffff',
      violation: 'STREAM_ID_EXHAUSTED(connection, PROTOCOL_ERROR)',
    },
  },
  H2_STREAM_HALF_CLOSED: {
    id: 'H2_STREAM_HALF_CLOSED',
    version: 'v1',
    summary: '半关闭方向上再收到 DATA/HEADERS/WINDOW_UPDATE 为 stream 错误 STREAM_CLOSED',
    basis: {
      localMeans: 'client(C2S) side',
      violation: 'STREAM_CLOSED_ON_HALF_CLOSED(stream, STREAM_CLOSED)',
      connectionStaysUsable: true,
    },
  },
  H2_SETTINGS_ACK: {
    id: 'H2_SETTINGS_ACK',
    version: 'v1',
    summary: 'SETTINGS ACK 不得携带负载，且必须对应一个未确认的 SETTINGS',
    basis: {
      ackWithPayload: 'SETTINGS_ACK_WITH_PAYLOAD(connection, PROTOCOL_ERROR)',
      ackWithoutPending: 'SETTINGS_ACK_WITHOUT_PENDING(connection, PROTOCOL_ERROR)',
      settingsOnStream: 'SETTINGS_ON_STREAM(connection, PROTOCOL_ERROR)',
    },
  },
};

export function ruleRef(id: keyof typeof RULES): { id: string; version: string; basis: Record<string, unknown> } {
  const r = RULES[id];
  return { id: r.id, version: r.version, basis: r.basis };
}

export const DEFAULT_PARAMS = {
  rulesetVersion: `${RULESET_ID}@v1`,
  settingsEffectivePoint: 'on-receipt' as 'on-receipt' | 'on-ack',
  initialMaxTableSize: 4096,
};
export type ReplayParams = typeof DEFAULT_PARAMS;
