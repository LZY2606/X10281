import type { RawFrame, RawSetting, SourceDiagnostic, SourceMaterial, RuleParameter, RuleVersion } from '../core/types.ts'
import { parseFrameHex, settingsPayload, stableHash } from '../core/binary.ts'
import { dynamicTableSizeUpdate, indexed, literalIncremental, concat } from './hpack.ts'
import { frame, goaway, settingsAck } from './frames.ts'

interface Def { segment: string; dir: 'request' | 'response'; hex: string; note?: string }

const defs: Def[] = [
  { segment: 'S1-request-baseline', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 4096], [3, 100]])) },
  { segment: 'S1-request-baseline', dir: 'request', hex: settingsAck() },
  { segment: 'S1-request-baseline', dir: 'request', hex: frame(1, 0x4, 1, concat(literalIncremental(':method', 'GET'), literalIncremental(':path', '/'), literalIncremental(':authority', 'example.test'), indexed(2))) },
  { segment: 'S1-request-baseline', dir: 'request', hex: frame(0, 0x1, 1) },
  { segment: 'S1-request-baseline', dir: 'request', hex: frame(3, 0, 1, '00000008') },

  { segment: 'S2-response-direction-isolation', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 4096], [3, 100]])) },
  { segment: 'S2-response-direction-isolation', dir: 'response', hex: frame(1, 0x4, 1, concat(literalIncremental(':status', '200'), literalIncremental('x-response-token', 'direction-specific'))) },
  { segment: 'S2-response-direction-isolation', dir: 'request', hex: frame(1, 0x4, 3, concat([0xbf])) },

  { segment: 'S3-concurrent-header-block', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 4096], [3, 100]])), note: 'M2 将此片段改为提前 END_HEADERS' },
  { segment: 'S3-concurrent-header-block', dir: 'request', hex: settingsAck() },
  { segment: 'S3-concurrent-header-block', dir: 'request', hex: frame(1, 0, 0, 5, concat(literalIncremental(':method', 'POST'))) },
  { segment: 'S3-concurrent-header-block', dir: 'request', hex: frame(0, 0, 5, '74657874') },
  { segment: 'S3-concurrent-header-block', dir: 'request', hex: frame(9, 0x4, 5, concat(literalIncremental(':path', '/upload'))) },

  { segment: 'S4-settings-ack-capacity', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 8192], [3, 100]])) },
  { segment: 'S4-settings-ack-capacity', dir: 'request', hex: frame(1, 0x4, 7, concat(dynamicTableSizeUpdate(8192), literalIncremental('x-large', 'ack-pending-capacity'))) },
  { segment: 'S4-settings-ack-capacity', dir: 'request', hex: settingsAck() },
  { segment: 'S4-settings-ack-capacity', dir: 'request', hex: frame(1, 0x4, 9, concat(dynamicTableSizeUpdate(8192), literalIncremental('x-large', 'after-ack-capacity'))) },
  { segment: 'S4-settings-ack-capacity', dir: 'request', hex: settingsAck() },

  { segment: 'S5-padding-overflow', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 4096]])) },
  { segment: 'S5-padding-overflow', dir: 'request', hex: settingsAck() },
  { segment: 'S5-padding-overflow', dir: 'request', hex: frame(1, 0x5, 11, concat(literalIncremental(':method', 'POST'), literalIncremental(':path', '/padded'))) },
  { segment: 'S5-padding-overflow', dir: 'request', hex: frame(0, 0x8, 11, '0a616263') },
  { segment: 'S5-padding-overflow', dir: 'request', hex: frame(0, 0x9, 11, '03616263000000') },

  { segment: 'S6-stream-id-exhaustion', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 4096]])) },
  { segment: 'S6-stream-id-exhaustion', dir: 'request', hex: settingsAck() },
  { segment: 'S6-stream-id-exhaustion', dir: 'request', hex: frame(1, 0x4, 2147483647, concat(literalIncremental(':method', 'GET'), literalIncremental(':path', '/last'))) },
  { segment: 'S6-stream-id-exhaustion', dir: 'request', hex: goaway(2147483647, 11, 'ids-exhausted') },

  { segment: 'S7-direction-table-mismatch', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 4096]])) },
  { segment: 'S7-direction-table-mismatch', dir: 'request', hex: settingsAck() },
  { segment: 'S7-direction-table-mismatch', dir: 'request', hex: frame(1, 0x4, 13, concat(literalIncremental(':method', 'GET'), literalIncremental(':path', '/table-a'))) },
  { segment: 'S7-direction-table-mismatch', dir: 'response', hex: frame(1, 0x4, 13, concat([indexed(62)])) },

  { segment: 'S8-half-closed-direction', dir: 'response', hex: frame(4, 0, 0, settingsPayload([[1, 4096]])) },
  { segment: 'S8-half-closed-direction', dir: 'request', hex: settingsAck() },
  { segment: 'S8-half-closed-direction', dir: 'request', hex: frame(1, 0x4, 15, concat(literalIncremental(':method', 'GET'), literalIncremental(':path', '/half'))) },
  { segment: 'S8-half-closed-direction', dir: 'request', hex: frame(0, 0x1, 15) },
  { segment: 'S8-half-closed-direction', dir: 'request', hex: frame(0, 0x1, 15, '6166746572') },

  { segment: 'S9-capture-boundary', dir: 'request', hex: frame(4, 0, 0, '0003') },
  { segment: 'S9-capture-boundary', dir: 'request', hex: frame(1, 0, 0, 17, concat(literalIncremental(':method', 'GET'))), note: 'END_STREAM+非 END_HEADERS 后采集缺口' },
  { segment: 'S9-capture-boundary', dir: 'request', hex: frame(15, 0, 0, '636170747572652d6761702d6265666f72652d756e6b6e6f776e2d74797065'), note: '未知帧在 HTTP/2 中可忽略；缺失的 CONTINUATION 与下一帧解释均保留为候选' },
  { segment: 'S9-capture-boundary', dir: 'request', hex: frame(4, 0, 0, '00ffffffffffffffff'), note: '未登记 SETTINGS ID 0x00ff 与 0xffffffff 保留原始表示，不映射内置规则' }
]


function buildContinuationLinks(versionId: string, frames: RawFrame[]) {
  const f12 = frames.find((frame) => frame.segmentId === 'S3-concurrent-header-block' && frame.sourceCoordinate.endsWith('/frame#3'))!
  const f14 = frames.find((frame) => frame.segmentId === 'S3-concurrent-header-block' && frame.sourceCoordinate.endsWith('/frame#5'))!
  const f38 = frames.find((frame) => frame.segmentId === 'S9-capture-boundary' && frame.sourceCoordinate.endsWith('/frame#2'))!
  if (versionId === 'M1-v1') {
    return [
      { id: 'CL-S3-0', frameId: f12.id, nextFrameId: f14.id, previousFrameId: null, position: 0, complete: true },
      { id: 'CL-S3-1', frameId: f14.id, nextFrameId: null, previousFrameId: f12.id, position: 1, complete: true },
      { id: 'CL-S9-0', frameId: f38.id, nextFrameId: null, previousFrameId: null, position: 0, complete: false }
    ]
  }
  return [
    { id: 'CL-S3-headers', frameId: f12.id, nextFrameId: null, previousFrameId: null, position: 0, complete: true },
    { id: 'CL-S3-orphan-continuation', frameId: f14.id, nextFrameId: null, previousFrameId: null, position: 0, complete: false },
    { id: 'CL-S9-0', frameId: f38.id, nextFrameId: null, previousFrameId: null, position: 0, complete: false }
  ]
}

function buildMaterial(versionId: 'M1-v1' | 'M1-v2'): SourceMaterial {
  const frames: RawFrame[] = []
  let offset = 0
  let local = 0
  for (const def of defs) {
    const id = `F-${String(local + 1).padStart(4, '0')}`
    let hex = def.hex
    let note = def.note
    if (versionId === 'M1-v2' && def.segment === 'S3-concurrent-header-block' && local === 11) {
      hex = frame(1, 0x4, 5, concat(literalIncremental(':method', 'POST')))
      note = '源数据修订：补全 END_HEADERS，DATA 因此合法；仅影响 S3'
    }
    if (versionId === 'M1-v2' && def.segment === 'S3-concurrent-header-block' && local === 13) {
      note = '源数据修订后成为流 5 中无法关联的 CONTINUATION，仍然只影响 S3'
    }
    frames.push(parseFrameHex(id, versionId, local + 1, def.segment, def.dir, hex, offset, `${def.segment}/frame#${local + 1}`, note))
    offset += hex.length / 2
    local += 1
  }

  const settings: RawSetting[] = []
  const known: Record<number, string> = { 1: 'HEADER_TABLE_SIZE', 3: 'MAX_CONCURRENT_STREAMS' }
  let settingOrdinal = 0
  for (const frame of frames) {
    if (frame.rawType !== 4 || (frame.flags & 1) === 1 || frame.payloadHex.length < 6) continue
    const payload = frame.payloadHex
    for (let i = 0; i + 6 <= payload.length; i += 6) {
      const settingId = Number.parseInt(payload.slice(i, i + 4), 16)
      const rawText = payload.slice(i + 4, i + 12)
      const numeric = Number.parseInt(rawText, 16)
      const registered = settingId === 1 || settingId === 3
      settings.push({
        id: `SET-${String(settingOrdinal + 1).padStart(3, '0')}`,
        frameId: frame.id,
        materialId: versionId,
        ordinal: settingOrdinal + 1,
        direction: frame.connectionDirection,
        settingId,
        name: known[settingId] ?? `UNKNOWN_SETTING_0x${settingId.toString(16).padStart(4, '0')}`,
        valueText: `0x${rawText}`,
        value: {
          value: registered ? numeric : rawText,
          unit: 'setting-id',
          basis: 'settings-point',
          coordinate: `${frame.id}.setting[${settingOrdinal}]`,
          rawText: `0x${settingId.toString(16).padStart(4, '0')}=0x${rawText}`
        },
        effectivePoint: `${frame.id}:received; ack-before-encoder-use-required`
      })
      settingOrdinal += 1
    }
  }

  const logicalFrame = (segment: string, ordinal: number) => frames.filter((candidate) => candidate.segmentId === segment)[ordinal - 1]!
  const diagnostics: SourceDiagnostic[] = [
    {
      id: 'DIAG-truncated-settings',
      materialId: versionId,
      frameId: 'S9#1',
      code: 'UNCONVERTIBLE_TUPLE_LENGTH',
      message: 'SETTINGS 有效载荷长度为 2 octets，不是 6 octets 元组倍数；原始片段保留在原位置。',
      severity: 'error',
      coordinate: `${logicalFrame('S9-capture-boundary', 1).sourceCoordinate}:payload[0..2]`,
      originalValue: '0003',
      conversionAttempted: 'SETTINGS tuple = 16-bit identifier + 32-bit value',
      retainedAt: `${logicalFrame('S9-capture-boundary', 1).id}.payloadHex`
    },
    {
      id: 'DIAG-unknown-setting',
      materialId: versionId,
      frameId: 'S9#4',
      code: 'UNREGISTERED_SETTING_IDENTIFIER',
      message: 'SETTINGS ID 0x00ff 未登记；值 0xffffffff 保留原始表示，不映射为内置参数。',
      severity: 'warning',
      coordinate: `${logicalFrame('S9-capture-boundary', 4).sourceCoordinate}:payload[0..6]`,
      originalValue: '0x00ff=0xffffffff',
      conversionAttempted: 'registered setting identifier',
      retainedAt: `${logicalFrame('S9-capture-boundary', 4).id}.payloadHex`
    },
    {
      id: 'DIAG-capture-gap',
      materialId: versionId,
      frameId: 'S9#3',
      code: 'CAPTURE_GAP_IN_HEADER_BLOCK',
      message: 'HEADERS 未置 END_HEADERS，下一个记录不是 CONTINUATION；缺失字节无法从材料恢复。',
      severity: 'warning',
      coordinate: `${logicalFrame('S9-capture-boundary', 2).sourceCoordinate}..${logicalFrame('S9-capture-boundary', 3).sourceCoordinate}`,
      originalValue: 'HEADERS stream=17 flags=0x1 then RAW type=15',
      conversionAttempted: 'CONTINUATION chain reconstruction',
      retainedAt: `${logicalFrame('S9-capture-boundary', 2).id}.sourceCoordinate,${logicalFrame('S9-capture-boundary', 3).id}.sourceCoordinate`
    }
  ]

  const content = frames.map((f) => `${f.id}:${f.rawHex}`).join('|')
  return {
    id: 'M1',
    versionId,
    label: 'HTTP/2 离线固定案例：帧、HPACK 动态表与流生命周期',
    importedAt: versionId === 'M1-v1' ? '2026-09-29T00:00:00+08:00' : '2026-09-29T01:00:00+08:00',
    frames,
    settings,
    continuationLinks: buildContinuationLinks(versionId, frames),
    diagnostics,
    contentHash: stableHash(content + versionId)
  }
}

function rule(id: string, label: string, params: Array<[string, string, string | number | boolean, string, string]>, createdFrom: string | null, rationale: string): RuleVersion {
  const parameters: RuleParameter[] = params.map(([name, text, value, unit, at]) => ({
    id: `RP-${name}`,
    name,
    valueText: text,
    value,
    unit: unit as RuleParameter['unit'],
    basis: 'settings-point',
    effectiveAtEvent: at
  }))
  return { id, label, createdFromRuleId: createdFrom, parameters, rationaleText: rationale }
}

export const materialV1 = buildMaterial('M1-v1')
export const materialV2 = buildMaterial('M1-v2')
export const ruleV1 = rule(
  'R1-rfc7540-rfc7541',
  'RFC 7540/7541 基线规则',
  [
    ['directionIsolation', 'HPACK request/response dynamic tables are separate', true, 'version', 'RULE-R1'],
    ['ackBoundary', 'SETTINGS_HEADER_TABLE_SIZE applies to encoder only after peer ACK', true, 'settings-point', 'RULE-R1'],
    ['strictContinuation', 'frames other than CONTINUATION are connection PROTOCOL_ERROR inside a header block', true, 'ordinal', 'RULE-R1'],
    ['scopeSeparation', 'connection and stream error scopes are not merged', true, 'version', 'RULE-R1']
  ],
  null,
  '严格按 RFC 7540 §4.3、§6、§7、§8.1 与 RFC 7541 §2、§3.2、§4.2 解释。'
)
export const ruleV2 = rule(
  'R2-retain-all-header-block-candidates',
  '采集边界参数修订',
  [
    ['directionIsolation', 'HPACK request/response dynamic tables are separate', true, 'version', 'RULE-R2'],
    ['ackBoundary', 'SETTINGS_HEADER_TABLE_SIZE applies to encoder only after peer ACK', true, 'settings-point', 'RULE-R2'],
    ['strictContinuation', 'retain all legal candidates when capture omits continuation boundary', false, 'ordinal', 'RULE-R2'],
    ['scopeSeparation', 'connection and stream error scopes are not merged', true, 'version', 'RULE-R2']
  ],
  'R1-rfc7540-rfc7541',
  '对完整字节仍严格裁决；仅当输入存在采集缺口时保留全部与可见片段相容的候选。'
)
