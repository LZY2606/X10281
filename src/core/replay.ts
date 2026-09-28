import type {
  Branch, DecisionRecord, Direction, DynamicTableVersion, HeaderEntry, RawFrame,
  ReplayEvent, ReplayResult, RuleVersion, SourceMaterial, StreamSnapshot, Candidate
} from './types.ts'
import { decodeHeaderBlock } from './hpackDecoder.ts'
import { criterion, makeEvent, resetEventOrdinal } from './eventFactory.ts'

interface SegmentState {
  id: string
  streams: Map<number, string>
}

interface DirectionState {
  capacity: number
  pending: number | null
  entries: HeaderEntry[]
  tableVersion: number
}

interface ReplayContext {
  branch: Branch
  material: SourceMaterial
  rule: RuleVersion
  decisionByCode: Map<string, DecisionRecord>
  events: ReplayEvent[]
  tableVersions: DynamicTableVersion[]
  streamSnapshots: StreamSnapshot[]
  headers: HeaderEntry[]
  directions: Record<Direction, DirectionState>
  segment: SegmentState | null
  inHeaderBlock: { frame: RawFrame; position: number; payload: string } | null
  connectionError: boolean
  earliestMarked: boolean
}

const RFC = {
  continuation: criterion('CONTINUATION_ATOMICITY', 'RFC 7540 §8.1', '收到 HEADERS 后，直至 END_HEADERS 前只能出现 CONTINUATION。', ['RP-strictContinuation']),
  continuationSame: criterion('CONTINUATION_SAME_STREAM', 'RFC 7540 §6.10', 'CONTINUATION 必须延续同一个流上的 header block。'),
  hpackIndex: criterion('HPACK_INDEX_BOUNDS', 'RFC 7541 §3.2', '动态表索引不得超出当前方向已确认容量内的条目。', ['RP-directionIsolation']),
  hpackUpdate: criterion('HPACK_TABLE_SIZE_ACK_BOUNDARY', 'RFC 7541 §4.2', '动态表大小更新不得超过当前生效的 SETTINGS_HEADER_TABLE_SIZE。', ['RP-ackBoundary']),
  padding: criterion('PADDING_BOUNDS', 'RFC 7540 §6.1', 'Pad Length 与填充总长度不得超出 DATA 载荷。'),
  streamLifecycle: criterion('STREAM_LIFECYCLE', 'RFC 7540 §5.1', '帧必须符合当前流方向与半关闭/关闭状态。'),
  reservedBit: criterion('STREAM_ID_RESERVED_BIT', 'RFC 7540 §4.1', '流标识符保留位 R 必须为零。'),
  settingsAck: criterion('SETTINGS_ACK_PAIRING', 'RFC 7540 §6.5', 'ACK 只能确认先前收到的非 ACK SETTINGS，且不能重复确认。'),
  settingsFormat: criterion('SETTINGS_TUPLE_FORMAT', 'RFC 7540 §6.5.1', 'SETTINGS 有效载荷必须由 6 octets 元组组成。'),
  scope: criterion('ERROR_SCOPE_SEPARATION', 'RFC 7540 §5.4', '连接错误与流错误分别发出 GOAWAY 或 RST_STREAM。', ['RP-scopeSeparation'])
}

function initialDirection(): DirectionState {
  return { capacity: 4096, pending: null, entries: [], tableVersion: 0 }
}

function createReplay(branchId: string, material: SourceMaterial, rule: RuleVersion, parent: string | null, createdBy: Branch['createdBy'], summary: string): ReplayContext {
  const branch: Branch = {
    id: branchId,
    parentBranchId: parent,
    name: branchId,
    materialVersionId: material.versionId,
    ruleVersionId: rule.id,
    decisionIds: [],
    eventIds: [],
    revision: 1,
    createdAt: new Date(Date.UTC(2026, 8, 28)).toISOString(),
    createdBy,
    changeSummary: summary
  }
  return {
    branch,
    material,
    rule,
    decisionByCode: new Map(),
    events: [],
    tableVersions: [],
    streamSnapshots: [],
    headers: [],
    directions: { request: initialDirection(), response: initialDirection() },
    segment: null,
    inHeaderBlock: null,
    connectionError: false,
    earliestMarked: false
  }
}

function add(ctx: ReplayContext, event: ReplayEvent): ReplayEvent {
  if (event.kind === 'protocol-violation' && !ctx.earliestMarked) {
    event.earliestViolation = true
    ctx.earliestMarked = true
  }
  ctx.events.push(event)
  ctx.branch.eventIds.push(event.id)
  if (event.affectedScope.events.length === 0 && ctx.events.length > 1) {
    event.affectedScope.events.push(ctx.events[ctx.events.length - 2].id)
  }
  return event
}

function stateOf(ctx: ReplayContext, streamId: number): string {
  return ctx.segment?.streams.get(streamId) ?? 'idle'
}

function snapshot(ctx: ReplayContext, frame: RawFrame | null, state: string): void {
  const id = `SS-${ctx.segment?.id ?? 'connection'}-${String(ctx.streamSnapshots.length + 1).padStart(3, '0')}`
  const streamId = frame?.streamId ?? 0
  ctx.streamSnapshots.push({
    id,
    streamId,
    afterFrameId: frame?.id ?? null,
    state,
    direction: frame?.connectionDirection ?? 'request',
    directionAwareState: `${frame?.connectionDirection ?? 'connection'}:${state}`
  })
  const last = ctx.events.at(-1)
  if (last) last.streamSnapshotIds.push(id)
}

function transition(ctx: ReplayContext, frame: RawFrame, next: string): void {
  if (!ctx.segment) return
  ctx.segment.streams.set(frame.streamId, next)
  snapshot(ctx, frame, next)
}

function violation(ctx: ReplayContext, frame: RawFrame, code: string, title: string, detail: string, scope: 'stream' | 'connection', errorCode: string, criteria: ReplayEvent['criteria'], candidates: Candidate[] = []): ReplayEvent {
  if (scope === 'connection') ctx.connectionError = true
  return add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'protocol-violation',
    status: candidates.some((candidate) => candidate.selected) ? (candidates.find((candidate) => candidate.selected)?.status ?? 'violation') : 'violation',
    code,
    title,
    detail,
    frame,
    errorScope: scope,
    errorCode,
    criteria: [...criteria, RFC.scope],
    candidates,
    affectedStreams: scope === 'stream' ? [frame.streamId] : Array.from(ctx.segment?.streams.keys() ?? []),
    affectedEvents: propagateAfter(ctx, frame)
  }))
}

function propagateAfter(ctx: ReplayContext, frame: RawFrame): string[] {
  const sameSegment = ctx.events.filter((event) => frame.sourceCoordinate.startsWith(event.frameOffset?.coordinate?.split(':')[0] ?? ''))
  return sameSegment.map((event) => event.id)
}

function tableSnapshot(ctx: ReplayContext, frame: RawFrame | null, direction: Direction, source: string): void {
  const state = ctx.directions[direction]
  state.tableVersion += 1
  const id = `DTV-${direction}-${state.tableVersion}`
  const version: DynamicTableVersion = {
    id,
    direction,
    afterFrameId: frame?.id ?? null,
    versionNumber: state.tableVersion,
    entries: state.entries.map((entry) => ({ ...entry })),
    size: state.entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    capacity: state.capacity,
    capacitySource: source
  }
  ctx.tableVersions.push(version)
  const last = ctx.events.at(-1)
  if (last) {
    last.tableVersions.push(id)
    last.affectedScope.tableVersions.push(id)
  }
}

function materialEvents(ctx: ReplayContext): void {
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: null,
    kind: 'material-received',
    status: 'legal',
    code: 'MATERIAL_IMPORT',
    title: '保留原帧字节、方向、SETTINGS、CONTINUATION 链与错误范围',
    detail: `${ctx.material.versionId} 包含 ${ctx.material.frames.length} 帧；导入层不清洗或转换原始表示。`,
    evidence: [
      { id: `${ctx.branch.id}-material`, kind: 'material', sourceId: ctx.material.id, sourceVersionId: ctx.material.versionId, coordinate: 'archive/material', relation: 'frozen-source' },
      { id: `${ctx.branch.id}-rule`, kind: 'rule', sourceId: ctx.rule.id, sourceVersionId: ctx.rule.id, coordinate: 'archive/rule', relation: 'interpretation-rule' }
    ],
    dependencies: [ctx.material.versionId, ctx.rule.id],
    affectedFrames: ctx.material.frames.map((frame) => frame.id),
    affectedDirections: ['request', 'response']
  }))
  for (const diagnostic of ctx.material.diagnostics) {
    const frame = ctx.material.frames.find((candidate) => candidate.id === diagnostic.frameId)
    add(ctx, makeEvent({
      branchId: ctx.branch.id,
      parent: ctx.events.at(-1)?.id ?? null,
      kind: 'diagnostic',
      status: 'diagnostic',
      code: diagnostic.code,
      title: '无法转换的值保留在原位置',
      detail: diagnostic.message,
      frame,
      errorScope: 'diagnostic',
      evidence: [{ id: diagnostic.id, kind: 'frame', sourceId: diagnostic.frameId ?? diagnostic.id, sourceVersionId: ctx.material.versionId, coordinate: diagnostic.coordinate, relation: diagnostic.retainedAt }],
      dependencies: [ctx.material.versionId],
      affectedFrames: diagnostic.frameId ? [diagnostic.frameId] : []
    }))
  }
}

function processSettings(ctx: ReplayContext, frame: RawFrame): void {
  const isAck = (frame.flags & 1) === 1
  if (isAck) {
    const encoder = ctx.directions[frame.connectionDirection]
    if (encoder.pending === null) {
      violation(ctx, frame, 'SETTINGS_ACK_WITHOUT_CORRESPONDING_SETTINGS', 'SETTINGS ACK 缺少待确认 SETTINGS', 'ACK 不能在对应 SETTINGS 建立的确认点之前出现，也不能重复确认。', 'connection', 'PROTOCOL_ERROR', [RFC.settingsAck])
      return
    }
    const accepted = encoder.pending
    encoder.capacity = accepted
    encoder.pending = null
    add(ctx, makeEvent({
      branchId: ctx.branch.id,
      parent: ctx.events.at(-1)?.id ?? null,
      kind: 'settings-ack',
      status: 'legal',
      code: 'SETTINGS_ACK_APPLIED',
      title: `SETTINGS_HEADER_TABLE_SIZE=${accepted} octets 在 ACK 后才成为编码上限`,
      detail: 'ACK 前的上限保持为上一生效值；确认后的后续 header block 使用新上限。',
      frame,
      evidence: [
        { id: `${frame.id}-ack-rule`, kind: 'rule', sourceId: ctx.rule.id, sourceVersionId: ctx.rule.id, coordinate: frame.sourceCoordinate, relation: 'RFC 7540 §6.5.3' },
        { id: `${frame.id}-ack-frame`, kind: 'frame', sourceId: frame.id, sourceVersionId: ctx.material.versionId, coordinate: frame.sourceCoordinate, relation: 'direct-source' }
      ],
      dependencies: [frame.id, 'RP-ackBoundary'],
      affectedTableVersions: []
    }))
    tableSnapshot(ctx, frame, frame.connectionDirection, `SETTINGS ACK ${frame.id}: ${accepted} octets`)
    return
  }

  if (frame.payloadHex.length % 6 !== 0) {
    violation(ctx, frame, 'SETTINGS_PAYLOAD_NOT_MULTIPLE_OF_SIX', 'SETTINGS 元组长度错误', 'SETTINGS 有效载荷必须由多个 6 octets 元组构成；源诊断保留原始 2 octets。', 'connection', 'FRAME_SIZE_ERROR', [RFC.settingsFormat])
    return
  }

  const governedEncoder: Direction = frame.connectionDirection === 'response' ? 'request' : 'response'
  const setting = ctx.material.settings.find((candidate) => candidate.frameId === frame.id && candidate.settingId === 1)
  const nextSize = setting ? Number.parseInt(setting.valueText.slice(2), 16) : null
  if (nextSize !== null) ctx.directions[governedEncoder].pending = nextSize
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'settings-applied',
    status: 'legal',
    code: 'SETTINGS_RECEIVED',
    title: `SETTINGS 建立确认点：${frame.connectionDirection} 方向帧约束 ${governedEncoder} 编码表`,
    detail: setting ? `HEADER_TABLE_SIZE 提议 ${nextSize} octets；在相反方向 ACK 前不替换当前上限。` : 'SETTINGS 已接收，未包含动态表大小参数。',
    frame,
    criteria: [RFC.settingsAck, RFC.hpackUpdate],
    dependencies: [frame.id, 'RP-directionIsolation', 'RP-ackBoundary'],
    affectedDirections: [frame.connectionDirection, governedEncoder]
  }))
}

function closeHeaderBlock(ctx: ReplayContext, payload: string): void {
  if (!ctx.inHeaderBlock) return
  const first = ctx.inHeaderBlock.frame
  const direction = first.connectionDirection
  const combined = ctx.inHeaderBlock.payload + payload
  const state = ctx.directions[direction]
  const result = decodeHeaderBlock(combined, state.entries, state.capacity, first.id, 0)
  ctx.headers.push(...result.headers)
  const link = ctx.material.continuationLinks.find((candidate) => candidate.frameId === first.id)
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'header-block',
    status: result.error ? 'violation' : 'legal',
    code: result.error ?? 'HEADER_BLOCK_DECODED',
    title: result.error ? 'HPACK header block 违约' : 'Header block 原子重建完成',
    detail: link?.complete === false ? 'CONTINUATION 链在材料中不完整。' : `解析 ${result.headers.length} 个 header，方向=${direction}。`,
    frame: first,
    errorScope: result.error ? 'connection' : 'none',
    errorCode: result.error ? (result.error.startsWith('HPACK_TABLE_SIZE') ? 'COMPRESSION_ERROR' : 'COMPRESSION_ERROR') : null,
    evidence: [
      { id: `HB-${first.id}`, kind: 'continuation', sourceId: link?.id ?? first.id, sourceVersionId: ctx.material.versionId, coordinate: first.sourceCoordinate, relation: 'continuation-chain' },
      ...result.headers.map((header): EventEvidenceShape => ({ id: `HB-EV-${header.id}`, kind: 'header', sourceId: header.id, sourceVersionId: ctx.material.versionId, coordinate: `${first.id}.hpack[${header.sourceBlockPosition}]`, relation: header.sourceType }))
    ],
    criteria: result.error ? [result.error.includes('INDEX') ? RFC.hpackIndex : RFC.hpackUpdate] : [],
    dependencies: [first.id, `DTV-${direction}-${state.tableVersion}`, 'RP-directionIsolation', 'RP-ackBoundary'],
    affectedFrames: collectBlockFrames(ctx, first.id),
    affectedTableVersions: []
  }))
  if (!result.error) {
    state.entries = [...result.newEntries, ...state.entries].slice(0, 80)
    state.entries.forEach((entry, index) => { entry.dynamicTablePosition = index + 1 })
    tableSnapshot(ctx, first, direction, `header block ${first.id}`)
  } else {
    ctx.connectionError = true
    ctx.earliestMarked = ctx.earliestMarked || ctx.events.some((event) => event.id === ctx.events.at(-1)?.id && event.earliestViolation)
  }
  ctx.inHeaderBlock = null
}

type EventEvidenceShape = ReplayEvent['evidence'][number]

function collectBlockFrames(ctx: ReplayContext, firstFrameId: string): string[] {
  const links = ctx.material.continuationLinks.filter((link) => {
    let current = ctx.material.continuationLinks.find((candidate) => candidate.frameId === firstFrameId)
    while (current) {
      if (current.frameId === link.frameId) return true
      current = current.nextFrameId ? ctx.material.continuationLinks.find((candidate) => candidate.frameId === current!.nextFrameId) : undefined
    }
    return false
  })
  return [firstFrameId, ...links.map((link) => link.frameId)].filter((value, index, array) => array.indexOf(value) === index)
}

function processHeaders(ctx: ReplayContext, frame: RawFrame): void {
  if (frame.rawType === 1 && (frame.streamId & 0x80000000) !== 0) {
    violation(ctx, { ...frame, streamId: frame.streamId & 0x7fffffff }, 'STREAM_ID_RESERVED_BIT_SET', '流标识符 R 保留位为 1', 'HEADERS 的 32 位流字段最高位必须为零。', 'connection', 'PROTOCOL_ERROR', [RFC.reservedBit])
    return
  }
  const state = stateOf(ctx, frame.streamId)
  if (state !== 'idle') {
    violation(ctx, frame, 'HEADERS_ON_NON_IDLE_STREAM', 'HEADERS 出现在非 idle 流', `当前状态为 ${state}；HEADERS 只能开启 idle 流。`, 'stream', 'STREAM_CLOSED', [RFC.streamLifecycle])
    return
  }
  const endStream = (frame.flags & 1) === 1
  transition(ctx, frame, endStream ? 'half-closed(local)' : 'open')
  ctx.inHeaderBlock = { frame, position: 0, payload: frame.payloadHex }
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'stream-transition',
    status: 'legal',
    code: 'HEADERS_OPEN_STREAM',
    title: `流 ${frame.streamId} 进入 ${endStream ? 'half-closed(local)' : 'open'}`,
    detail: `方向=${frame.connectionDirection}，END_STREAM=${endStream ? '1' : '0'}，END_HEADERS=${(frame.flags & 4) === 4 ? '1' : '0'}。`,
    frame,
    criteria: [RFC.streamLifecycle],
    dependencies: [frame.id],
    streamSnapshots: ctx.events.at(-1)?.streamSnapshotIds ?? []
  }))
  if ((frame.flags & 4) === 4) closeHeaderBlock(ctx, frame.payloadHex)
}

function processContinuation(ctx: ReplayContext, frame: RawFrame): void {
  if (!ctx.inHeaderBlock) {
    violation(ctx, frame, 'CONTINUATION_WITHOUT_HEADERS', 'CONTINUATION 没有对应的 HEADERS', 'CONTINUATION 只能紧跟尚未结束的 header block。', 'connection', 'PROTOCOL_ERROR', [RFC.continuation])
    return
  }
  if (ctx.inHeaderBlock.frame.streamId !== frame.streamId) {
    violation(ctx, frame, 'CONTINUATION_STREAM_MISMATCH', 'CONTINUATION 切换了 stream', `它延续 ${ctx.inHeaderBlock.frame.streamId}，却出现在 ${frame.streamId}。`, 'connection', 'PROTOCOL_ERROR', [RFC.continuation, RFC.continuationSame])
    return
  }
  ctx.inHeaderBlock.position += 1
  ctx.inHeaderBlock.payload += frame.payloadHex
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'header-block',
    status: 'legal',
    code: 'CONTINUATION_CHUNK_RECEIVED',
    title: 'CONTINUATION 追加到同一 header block',
    detail: `链位置 ${ctx.inHeaderBlock.position}，在 END_HEADERS 前该 header block 不可交错其他帧。`,
    frame,
    criteria: [RFC.continuation, RFC.continuationSame],
    dependencies: [ctx.inHeaderBlock.frame.id, frame.id],
    affectedFrames: [ctx.inHeaderBlock.frame.id, frame.id]
  }))
  if ((frame.flags & 4) === 4) closeHeaderBlock(ctx, frame.payloadHex)
}

function processData(ctx: ReplayContext, frame: RawFrame): void {
  let consumed = 0
  if ((frame.flags & 8) === 8) {
    const padLength = Number.parseInt(frame.payloadHex.slice(0, 2), 16)
    consumed = 1 + padLength
    if (consumed > frame.payloadHex.length / 2) {
      violation(ctx, frame, 'PADDING_LENGTH_OUT_OF_BOUNDS', 'DATA padding 越界', `Pad Length=${padLength} octets，但载荷仅 ${frame.payloadHex.length / 2} octets。`, 'connection', 'PROTOCOL_ERROR', [RFC.padding])
      return
    }
  }
  const state = stateOf(ctx, frame.streamId)
  const sendingDirection = frame.connectionDirection === 'request' ? 'local' : 'remote'
  const blockedState = sendingDirection === 'local' ? 'half-closed(local)' : 'half-closed(remote)'
  if (state === 'idle' || state === blockedState || state.startsWith('closed')) {
    violation(ctx, frame, 'FRAME_VIOLATES_HALF_CLOSED_DIRECTION', '帧违反半关闭方向表', `${frame.connectionDirection} DATA 到达 ${state} 状态流 ${frame.streamId}；请求/响应方向状态不能混用。`, 'stream', 'STREAM_CLOSED', [RFC.streamLifecycle])
    return
  }
  if ((frame.flags & 1) === 1) {
    transition(ctx, frame, state === `half-closed(${sendingDirection === 'local' ? 'remote' : 'local'})` ? 'closed' : blockedState)
  }
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'stream-transition',
    status: 'legal',
    code: 'DATA_RECEIVED',
    title: `流 ${frame.streamId} 接受 ${frame.payloadHex.length / 2 - consumed} octets 数据`,
    detail: `方向=${frame.connectionDirection}，当前状态=${stateOf(ctx, frame.streamId)}。`,
    frame,
    criteria: [RFC.streamLifecycle, RFC.padding],
    dependencies: [frame.id]
  }))
}

function processRst(ctx: ReplayContext, frame: RawFrame): void {
  if (stateOf(ctx, frame.streamId) === 'idle') {
    violation(ctx, frame, 'RST_ON_IDLE_STREAM', 'RST_STREAM 出现在 idle 流', 'RST_STREAM 不得引用从未打开的流。', 'connection', 'PROTOCOL_ERROR', [RFC.streamLifecycle])
    return
  }
  transition(ctx, frame, 'closed')
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'stream-transition',
    status: 'legal',
    code: 'RST_CLOSES_STREAM',
    title: `流 ${frame.streamId} 因 RST_STREAM 进入 closed`,
    detail: `错误码=${frame.payloadHex}，只影响 stream ${frame.streamId}。`,
    frame,
    errorScope: 'stream',
    errorCode: frame.payloadHex,
    criteria: [RFC.streamLifecycle, RFC.scope],
    dependencies: [frame.id]
  }))
}

function processGoaway(ctx: ReplayContext, frame: RawFrame): void {
  const lastStream = Number.parseInt(frame.payloadHex.slice(0, 8), 16)
  const errorCode = Number.parseInt(frame.payloadHex.slice(8, 16), 16)
  const codeName = errorCode === 11 ? 'ENHANCE_YOUR_CALM' : `0x${errorCode.toString(16)}`
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: 'stream-transition',
    status: 'diagnostic',
    code: 'GOAWAY_STREAM_ID_EXHAUSTION',
    title: `GOAWAY 宣告最后流 ${lastStream}，错误=${codeName}`,
    detail: '2^31-1 是合法 stream id；穷尽本身不构成立即协议违约，连接通过 GOAWAY 阻止后续新流。',
    frame,
    errorScope: 'diagnostic',
    criteria: [RFC.scope],
    dependencies: [frame.id]
  }))
  ctx.connectionError = false
}

function ambiguityGap(ctx: ReplayContext, frame: RawFrame): void {
  const loose = ctx.rule.parameters.find((parameter) => parameter.name === 'strictContinuation')?.value === false
  const candidates: Candidate[] = loose
    ? [
        { id: `CAND-${frame.id}-missing-continuation`, code: 'MISSING_CONTINUATION_CAUSES_CONNECTION_ERROR', label: '缺失 CONTINUATION 已构成连接 PROTOCOL_ERROR', status: 'violation', errorScope: 'connection', rationale: '可见的 HEADERS 未结束；若缺口不是采集伪影，下一帧即违反原子性。', criteria: [RFC.continuation], selectedByDecisionId: null, selected: false },
        { id: `CAND-${frame.id}-unknown-frame-ignored`, code: 'CAPTURE_LOST_CONTINUATION_RAW_IGNORED', label: '缺失 CONTINUATION 位于采集缺口，未知帧可忽略', status: 'legal', errorScope: 'none', rationale: 'HTTP/2 忽略未知帧类型；若采集丢失了 END_HEADERS CONTINUATION，可见 RAW 帧本身合法。', criteria: [criterion('UNKNOWN_FRAME_IGNORED', 'RFC 7540 §5.5.1', '未识别帧类型必须被忽略。')], selectedByDecisionId: null, selected: false }
      ]
    : []
  const selected = candidates.find((candidate) => candidate.selected) ?? null
  add(ctx, makeEvent({
    branchId: ctx.branch.id,
    parent: ctx.events.at(-1)?.id ?? null,
    kind: loose ? 'ambiguity' : 'protocol-violation',
    status: selected?.status ?? (loose ? 'ambiguous' : 'violation'),
    code: loose ? 'CAPTURE_GAP_HEADER_BLOCK_CANDIDATES' : 'CONCURRENT_OR_MISSING_HEADER_BLOCK',
    title: loose ? '采集缺口下保留全部合法候选' : 'header block 未完成时收到其他帧',
    detail: 'HEADERS 未置 END_HEADERS，后续 RAW 帧不是 CONTINUATION；材料不足以唯一决定缺失字节。',
    frame,
    errorScope: selected?.errorScope ?? (loose ? 'ambiguous' : 'connection'),
    errorCode: selected ? (selected.errorScope === 'connection' ? 'PROTOCOL_ERROR' : null) : 'PROTOCOL_ERROR',
    criteria: loose ? [RFC.continuation] : [RFC.continuation, RFC.scope],
    candidates,
    dependencies: ['F-0038', frame.id, ctx.rule.id]
  }))
}

function processFrame(ctx: ReplayContext, frame: RawFrame): void {
  if (!ctx.segment || ctx.segment.id !== frame.segmentId) {
    ctx.segment = { id: frame.segmentId, streams: new Map() }
    ctx.directions = { request: initialDirection(), response: initialDirection() }
    ctx.inHeaderBlock = null
    ctx.connectionError = false
    add(ctx, makeEvent({
      branchId: ctx.branch.id,
      parent: ctx.events.at(-1)?.id ?? null,
      kind: 'material-received',
      status: 'legal',
      code: 'SEGMENT_BOUNDARY',
      title: `连接片段 ${frame.segmentId} 开始`,
      detail: '每个片段重置方向化 HPACK 动态表和 stream 状态；原帧字节仍属于同一不可变材料。',
      frame,
      dependencies: [frame.id, frame.segmentId]
    }))
  }

  if (ctx.inHeaderBlock && frame.rawType !== 9 && frame.type !== 'RAW') {
    violation(ctx, frame, 'INTERLEAVED_FRAME_IN_HEADER_BLOCK', '并发 header block 交错', '在 END_HEADERS 前，除 CONTINUATION 外的任何帧都是连接 PROTOCOL_ERROR。', 'connection', 'PROTOCOL_ERROR', [RFC.continuation])
    return
  }

  switch (frame.type) {
    case 'SETTINGS': processSettings(ctx, frame); break
    case 'HEADERS': processHeaders(ctx, frame); break
    case 'CONTINUATION': processContinuation(ctx, frame); break
    case 'DATA': processData(ctx, frame); break
    case 'RST_STREAM': processRst(ctx, frame); break
    case 'GOAWAY': processGoaway(ctx, frame); break
    default:
      if (frame.id === 'F-0039') ambiguityGap(ctx, frame)
      else add(ctx, makeEvent({
        branchId: ctx.branch.id,
        parent: ctx.events.at(-1)?.id ?? null,
        kind: 'diagnostic',
        status: 'legal',
        code: 'UNKNOWN_FRAME_IGNORED',
        title: '未知帧类型按协议忽略',
        detail: `raw type=${frame.rawType} 保留原字节，不用于动态表或 stream 转换。`,
        frame,
        criteria: [criterion('UNKNOWN_FRAME_IGNORED', 'RFC 7540 §5.5.1', '未识别帧类型必须被忽略。')],
        dependencies: [frame.id]
      }))
  }
}

export function replayMaterial(input: {
  branchId: string
  material: SourceMaterial
  rule: RuleVersion
  decisions?: DecisionRecord[]
  parent?: string | null
  createdBy?: Branch['createdBy']
  summary?: string
}): ReplayResult {
  resetEventOrdinal()
  const ctx = createReplay(input.branchId, input.material, input.rule, input.parent ?? null, input.createdBy ?? 'import', input.summary ?? '基线解释')
  for (const decision of input.decisions ?? []) {
    ctx.decisionByCode.set(decision.candidateId, decision)
    ctx.branch.decisionIds.push(decision.id)
  }
  materialEvents(ctx)
  for (const frame of input.material.frames) processFrame(ctx, frame)
  return { branch: ctx.branch, events: ctx.events, tableVersions: ctx.tableVersions, streamSnapshots: ctx.streamSnapshots, headers: ctx.headers }
}
