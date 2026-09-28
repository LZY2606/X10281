export type Direction = 'request' | 'response'

export type FrameType =
  | 'DATA'
  | 'HEADERS'
  | 'PRIORITY'
  | 'RST_STREAM'
  | 'SETTINGS'
  | 'PUSH_PROMISE'
  | 'PING'
  | 'GOAWAY'
  | 'WINDOW_UPDATE'
  | 'CONTINUATION'
  | 'RAW'

export type ErrorScope = 'none' | 'stream' | 'connection' | 'diagnostic' | 'ambiguous'

export type RuleStatus = 'legal' | 'violation' | 'diagnostic' | 'ambiguous'

export type CoordinateBasis = 'frame-offset' | 'hpack-octet-offset' | 'stream-id' | 'settings-point' | 'capture-ordinal'

export type Unit = 'octets' | 'stream-id' | 'setting-id' | 'ordinal' | 'octet-offset' | 'version'

export interface UnitValue {
  value: string | number
  unit: Unit
  basis?: CoordinateBasis
  coordinate?: string
  rawText?: string
}

export interface RawFrame {
  id: string
  materialId: string
  ordinal: number
  segmentId: string
  connectionDirection: Direction
  type: FrameType
  rawType: number
  flags: number
  streamId: number
  payloadHex: string
  rawHex: string
  offset: UnitValue
  length: UnitValue
  sourceCoordinate: string
  note?: string
}

export interface RawSetting {
  id: string
  frameId: string
  materialId: string
  ordinal: number
  direction: Direction
  settingId: number
  name: string
  valueText: string
  value: UnitValue
  effectivePoint: string
}

export interface ContinuationLink {
  id: string
  frameId: string
  nextFrameId: string | null
  previousFrameId: string | null
  position: number
  complete: boolean
}

export interface SourceMaterial {
  id: string
  versionId: string
  label: string
  importedAt: string
  frames: RawFrame[]
  settings: RawSetting[]
  continuationLinks: ContinuationLink[]
  diagnostics: SourceDiagnostic[]
  contentHash: string
}

export interface SourceDiagnostic {
  id: string
  materialId: string
  frameId?: string
  code: string
  message: string
  severity: 'info' | 'warning' | 'error'
  coordinate: string
  originalValue: string
  conversionAttempted: string | null
  retainedAt: string
}

export interface RuleParameter {
  id: string
  name: string
  valueText: string
  value: string | number | boolean
  unit?: Unit
  basis: CoordinateBasis
  effectiveAtEvent: string
}

export interface RuleVersion {
  id: string
  label: string
  createdFromRuleId: string | null
  parameters: RuleParameter[]
  rationaleText: string
}

export interface HeaderEntry {
  id: string
  name: string
  value: string
  sourceType: 'static' | 'dynamic' | 'literal' | 'incremental'
  sourceIndex: number | null
  sourceFrameId: string
  sourceBlockPosition: number
  dynamicTablePosition?: number
  size?: number
}

export interface DynamicTableVersion {
  id: string
  direction: Direction
  afterFrameId: string | null
  versionNumber: number
  entries: HeaderEntry[]
  size: number
  capacity: number
  capacitySource: string
}

export interface StreamSnapshot {
  id: string
  streamId: number
  afterFrameId: string | null
  state: string
  direction: Direction
  directionAwareState: string
}

export interface EventEvidence {
  id: string
  kind: 'frame' | 'setting' | 'continuation' | 'header' | 'table-version' | 'rule' | 'decision' | 'material'
  sourceId: string
  sourceVersionId: string
  coordinate: string
  relation: string
}

export interface RuleCriterion {
  id: string
  code: string
  rfc: string
  text: string
  parameterIds: string[]
}

export interface ReplayEvent {
  id: string
  branchId: string
  parentEventId: string | null
  ordinal: number
  kind:
    | 'material-received'
    | 'settings-applied'
    | 'settings-ack'
    | 'header-block'
    | 'dynamic-table-update'
    | 'stream-transition'
    | 'protocol-violation'
    | 'ambiguity'
    | 'diagnostic'
    | 'decision'
  status: RuleStatus
  code: string
  title: string
  detail: string
  atFrameId: string | null
  direction: Direction | 'connection'
  errorScope: ErrorScope
  errorCode: string | null
  streamId: number | null
  earliestViolation: boolean
  evidence: EventEvidence[]
  criteria: RuleCriterion[]
  candidates: Candidate[]
  frameOffset: UnitValue | null
  tableVersions: string[]
  streamSnapshotIds: string[]
  dependencies: string[]
  affectedScope: {
    frames: string[]
    streams: number[]
    directions: Direction[]
    tableVersions: string[]
    events: string[]
  }
  createdAt: string
}

export interface Candidate {
  id: string
  code: string
  label: string
  status: RuleStatus
  errorScope: ErrorScope
  rationale: string
  criteria: RuleCriterion[]
  selectedByDecisionId: string | null
  selected: boolean
}

export interface DecisionRecord {
  id: string
  branchId: string
  baseBranchId: string
  ambiguityEventId: string
  candidateId: string
  accepted: boolean
  note: string
  parentDecisionId: string | null
  createdAt: string
  revision: number
  expectedRevision?: number
}

export interface Branch {
  id: string
  parentBranchId: string | null
  name: string
  materialVersionId: string
  ruleVersionId: string
  decisionIds: string[]
  eventIds: string[]
  revision: number
  createdAt: string
  createdBy: 'import' | 'parameter' | 'material' | 'decision'
  changeSummary: string
}

export interface Archive {
  format: 'hpack-state-mirror-archive'
  formatVersion: 1
  exportedAt: string
  materials: SourceMaterial[]
  ruleVersions: RuleVersion[]
  branches: Branch[]
  decisions: DecisionRecord[]
  events: ReplayEvent[]
  tableVersions: DynamicTableVersion[]
  streamSnapshots: StreamSnapshot[]
  headers: HeaderEntry[]
}

export interface ReplayResult {
  branch: Branch
  events: ReplayEvent[]
  tableVersions: DynamicTableVersion[]
  streamSnapshots: StreamSnapshot[]
  headers: HeaderEntry[]
}
