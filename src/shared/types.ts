// Domain types shared by the protocol engine, store layer, API and UI.

/** Connection direction of a frame / table / event, relative to the recorded TCP connection. */
export type Direction = 'C2S' | 'S2C';

/** RFC 9113 HTTP/2 frame type codes (plus UNKNOWN for reserved/unknown types). */
export const FRAME_TYPES = {
  DATA: 0x0,
  HEADERS: 0x1,
  PRIORITY: 0x2,
  RST_STREAM: 0x3,
  SETTINGS: 0x4,
  PUSH_PROMISE: 0x5,
  PING: 0x6,
  GOAWAY: 0x7,
  WINDOW_UPDATE: 0x8,
  CONTINUATION: 0x9,
} as const;
export type FrameTypeName =
  | 'DATA' | 'HEADERS' | 'PRIORITY' | 'RST_STREAM' | 'SETTINGS'
  | 'PUSH_PROMISE' | 'PING' | 'GOAWAY' | 'WINDOW_UPDATE' | 'CONTINUATION' | 'UNKNOWN';

export const ERROR_CODES = {
  NO_ERROR: 0x0,
  PROTOCOL_ERROR: 0x1,
  INTERNAL_ERROR: 0x2,
  FLOW_CONTROL_ERROR: 0x3,
  SETTINGS_TIMEOUT: 0x4,
  STREAM_CLOSED: 0x5,
  FRAME_SIZE_ERROR: 0x6,
  REFUSED_STREAM: 0x7,
  CANCEL: 0x8,
  COMPRESSION_ERROR: 0x9,
  CONNECT_ERROR: 0xa,
  ENHANCE_YOUR_CALM: 0xb,
  INADEQUATE_SECURITY: 0xc,
  HTTP_1_1_REQUIRED: 0xd,
} as const;
export type ErrorCodeName = keyof typeof ERROR_CODES;

/** Error scope: connection-level (GOAWAY) vs stream-level (RST_STREAM), per RFC 9113 §5.4/§7. */
export type ErrorScope = 'connection' | 'stream';

/** A value that keeps its original representation plus an optional normalized layer. */
export interface Unit<T> {
  /** Original representation exactly as imported; never rewritten. */
  raw: T;
  /** Unit or coordinate basis of the quantity. */
  unit: string;
  /** Normalized value in the derived layer; absent when conversion is impossible. */
  normalized?: number;
  /** Diagnostic when normalization could not be performed. */
  diagnostic?: string;
}

/** Original frame bytes with their coordinate basis (byte offsets within the capture). */
export interface RawFrameInput {
  /** Stable ordinal (0-based) within the direction's ordered frame stream. */
  ordinal: number;
  direction: Direction;
  /** Hex string of the full on-wire frame (9-byte header + payload), lowercase. */
  hex: string;
  /** Coordinate basis: byte offset of the frame header within the captured direction bytes. */
  byteOffset: number;
  /** Optional timestamp with explicit unit basis (milliseconds since capture start). */
  tMs?: number;
  /** Operator note; source data, never inferred. */
  note?: string;
}

export interface SettingsParameter {
  /** RFC 9113 §6.5.2 setting identifier (or raw id for unknown settings). */
  id: number;
  name: string;
  /** Raw 32-bit value as carried on the wire. */
  rawValue: number;
  /** Normalized value with unit basis; absent for unknown/unconvertible settings. */
  unit: string | null;
  normalized?: number;
  diagnostic?: string;
}

export type HeaderOriginKind =
  | 'static' | 'dynamic' | 'literal-incremental' | 'literal-without-indexing' | 'literal-never-indexed'
  | 'dynamic-size-update' | 'unparseable';

export interface DecodedHeader {
  name: string;
  value: string;
  /** Representation byte offset within the concatenated header block fragment (coordinate basis). */
  blockOffset: number;
  /** Wire representation length in bytes. */
  length: number;
  huffmanName: boolean;
  huffmanValue: boolean;
  origin: HeaderOriginKind;
  /** 1-based HPACK index for indexed/dynamic references; static indices are <= 61. */
  tableIndex?: number;
  dynamicTableVersion?: string;
}

export interface ParsedFrame {
  frameId: string;
  ordinal: number;
  direction: Direction;
  byteOffset: number;
  tMs?: number;
  length: number;
  type: FrameTypeName;
  typeCode: number;
  flags: number;
  streamId: number;
  payloadHex: string;
  note?: string;
  // Derived payload views (the raw bytes remain untouched).
  settings?: SettingsParameter[];
  headers?: DecodedHeader[];
  paddingLength?: number;
  dataPayloadHex?: string;
  padOverrun?: boolean;
  parseDiagnostics: string[];
}

/** Continuation chain link record. */
export interface ContinuationChainLink {
  frameId: string;
  ordinal: number;
  isHead: boolean;
  endHeaders: boolean;
  fragmentHex: string;
}

export interface ContinuationChain {
  id: string;
  direction: Direction;
  streamId: number;
  links: ContinuationChainLink[];
  complete: boolean;
  diagnostics: string[];
}

/** RFC 7541 dynamic table entry with 1-based dynamic index coordinates. */
export interface DynamicTableEntryView {
  /** 1-based dynamic index (most recent = 1). */
  dynamicIndex: number;
  /** Absolute HPACK index (static size + dynamic index). */
  absoluteIndex: number;
  name: string;
  value: string;
  /** Wire size per RFC 7541 §4.1 (octets). */
  entrySize: number;
  /** Coordinate: frame ordinal that inserted the entry. */
  insertedByOrdinal: number;
  frameId: string;
}

export interface DynamicTableVersionView {
  id: string;
  direction: Direction;
  afterOrdinal: number;
  frameId: string;
  capacity: number;
  declaredMax: number;
  confirmedMax: number;
  pendingMax: number | null;
  size: number;
  entries: DynamicTableEntryView[];
  change: 'init' | 'insert' | 'evict' | 'capacity-ack' | 'capacity-pending' | 'size-update' | 'frozen';
}

/** RFC 9113 §5.1 stream states, recorded independently per stream id. */
export type StreamState =
  | 'idle' | 'reserved-local' | 'reserved-remote'
  | 'open' | 'half-closed-local' | 'half-closed-remote' | 'closed';

export interface StreamStateView {
  streamId: number;
  state: StreamState;
  /** Coordinate of the state transition (direction + ordinal). */
  sinceOrdinal: number;
  sinceDirection: Direction;
  /** Highest ordinal at which the endpoint may still open this parity stream. */
  lastFrameId?: string;
}

export type MachineEventType =
  | 'frame'
  | 'settings-effective'
  | 'settings-ack-observed'
  | 'header-block'
  | 'hpack-decode'
  | 'dynamic-table-version'
  | 'stream-transition'
  | 'protocol-violation'
  | 'candidate'
  | 'candidate-ruling'
  | 'fatal-connection-error'
  | 'diagnostic-retained';

export interface ProtocolViolation {
  ruleId: string;
  rfcCitation: string;
  code: ErrorCodeName;
  scope: ErrorScope;
  streamId: number | null;
  direction: Direction;
  ordinal: number;
  frameId: string;
  message: string;
}

export interface MachineEvent {
  /** Stable identity: survives export/delete/import. */
  id: string;
  type: MachineEventType;
  seq: number;
  direction: Direction | null;
  ordinal: number | null;
  frameId: string | null;
  streamId: number | null;
  label: string;
  payload: unknown;
  ruleVersion?: string;
  paramVersionId?: string;
  materialVersionId?: string;
}

export interface CandidateOption {
  id: string;
  label: string;
  rationale: string;
  ruleId: string;
}

export interface ReplayView {
  caseId: string;
  branchId: string;
  ruleVersion: string;
  paramVersionId: string;
  materialVersionId: string;
  timeline: MachineEvent[];
  frames: ParsedFrame[];
  streams: StreamStateView[];
  tableVersions: DynamicTableVersionView[];
  chains: ContinuationChain[];
  violations: ProtocolViolation[];
  earliestViolationId: string | null;
  fatalConnectionErrorOrdinal: number | null;
  candidates: CandidateQuestion[];
  /** Directed dependency edges between stable ids, used for invalidation scoping. */
  dependencies: DependencyEdge[];
}

export interface CandidateQuestion {
  id: string;
  frameId: string;
  direction: Direction;
  ordinal: number;
  streamId: number | null;
  prompt: string;
  ruleId: string;
  options: CandidateOption[];
  resolvedOptionId: string | null;
  decisionId: string | null;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: 'frame->event' | 'param->event' | 'rule->event' | 'material->frame' | 'frame->frame' | 'decision->event';
}

export interface CaseMeta {
  id: string;
  title: string;
  description: string;
  protocol: string;
  rfcBasis: string[];
}

export interface OfflineCaseBundle {
  formatVersion: 1;
  caseMeta: CaseMeta;
  frames: RawFrameInput[];
  initialParams: ParamPatch;
  narrative: NarrativeStep[];
  /** Expected scenario tags actually traversed by the replay. */
  scenarioTags: string[];
}

export interface ParamPatch {
  /** Policy deciding when SETTINGS_HEADER_TABLE_SIZE limits the decoder table. */
  tableSizeEffectivePoint: 'on-receipt' | 'on-ack';
  /** Default assumed HEADER_TABLE_SIZE before the peer SETTINGS arrives (octets). */
  defaultHeaderTableSize: number;
  ruleVersion: string;
  note: string;
}

export interface NarrativeStep {
  id: string;
  title: string;
  detail: string;
}
