import type { Direction, EventEvidence, FrameType, RawFrame, ReplayEvent, RuleCriterion, RuleStatus, ErrorScope, UnitValue, Candidate } from './types.ts'

let globalOrdinal = 0

export function resetEventOrdinal(): void { globalOrdinal = 0 }

export function criterion(code: string, rfc: string, text: string, parameterIds: string[] = []): RuleCriterion {
  return { id: `RC-${code}`, code, rfc, text, parameterIds }
}

export function frameEvidence(frame: RawFrame, relation: string): EventEvidence {
  return {
    id: `EV-${frame.id}-${relation}`,
    kind: 'frame',
    sourceId: frame.id,
    sourceVersionId: frame.materialId,
    coordinate: frame.sourceCoordinate,
    relation
  }
}

export function makeEvent(input: {
  branchId: string
  parent: string | null
  kind: ReplayEvent['kind']
  status: RuleStatus
  code: string
  title: string
  detail: string
  frame?: RawFrame | null
  direction?: Direction | 'connection'
  errorScope?: ErrorScope
  errorCode?: string | null
  streamId?: number | null
  earliest?: boolean
  evidence?: EventEvidence[]
  criteria?: RuleCriterion[]
  candidates?: Candidate[]
  offset?: UnitValue | null
  tableVersions?: string[]
  streamSnapshots?: string[]
  dependencies?: string[]
  affectedFrames?: string[]
  affectedStreams?: number[]
  affectedDirections?: Direction[]
  affectedTableVersions?: string[]
  affectedEvents?: string[]
}): ReplayEvent {
  globalOrdinal += 1
  const frame = input.frame ?? null
  const direction = input.direction ?? frame?.connectionDirection ?? 'connection'
  return {
    id: `${input.branchId}/E${String(globalOrdinal).padStart(3, '0')}`,
    branchId: input.branchId,
    parentEventId: input.parent,
    ordinal: globalOrdinal,
    kind: input.kind,
    status: input.status,
    code: input.code,
    title: input.title,
    detail: input.detail,
    atFrameId: frame?.id ?? null,
    direction,
    errorScope: input.errorScope ?? 'none',
    errorCode: input.errorCode ?? null,
    streamId: input.streamId ?? frame?.streamId ?? null,
    earliestViolation: input.earliest ?? false,
    evidence: input.evidence ?? (frame ? [frameEvidence(frame, 'direct-source')] : []),
    criteria: input.criteria ?? [],
    candidates: input.candidates ?? [],
    frameOffset: input.offset ?? frame?.offset ?? null,
    tableVersions: input.tableVersions ?? [],
    streamSnapshotIds: input.streamSnapshots ?? [],
    dependencies: input.dependencies ?? (frame ? [frame.id] : []),
    affectedScope: {
      frames: input.affectedFrames ?? (frame ? [frame.id] : []),
      streams: input.affectedStreams ?? (frame?.streamId ? [frame.streamId] : []),
      directions: input.affectedDirections ?? (direction === 'connection' ? [] : [direction]),
      tableVersions: input.affectedTableVersions ?? input.tableVersions ?? [],
      events: input.affectedEvents ?? []
    },
    createdAt: new Date(Date.UTC(2026, 8, 28, 0, globalOrdinal)).toISOString()
  }
}

export function frameTypeLabel(frame: RawFrame): FrameType { return frame.type }
