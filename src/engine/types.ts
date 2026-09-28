import type {
  Direction,
  ErrorScope,
  HeaderField,
  JudgmentBasis,
  ParsedFrame,
  StreamState,
} from "../protocol/types.ts";

export type RuleVersion = "RFC7540" | "RFC9113";

/** 分支参数：参数修订会让依赖该参数的结论进入失效范围。 */
export interface BranchParams {
  ruleVersion: RuleVersion;
  initialDynamicTableSize: number; // octets
  initialMaxFrameSize: number; // octets
  /** stream id 穷尽策略：到达 2^31-1 附近时按严格连接错误还是诊断保留候选。 */
  streamIdExhaustionPolicy: "strict" | "diagnostic";
}

export const DEFAULT_PARAMS: BranchParams = {
  ruleVersion: "RFC9113",
  initialDynamicTableSize: 4096,
  initialMaxFrameSize: 16384,
  streamIdExhaustionPolicy: "strict",
};

export type EngineEventType =
  | "material.frame"
  | "settings.effective"
  | "settings.ack"
  | "continuation.chain"
  | "hpack.table-version"
  | "hpack.header"
  | "stream.state"
  | "violation"
  | "decision"
  | "branch"
  | "diagnostic";

export interface SettingsEffectiveEvent {
  type: "settings.effective";
  id: string;
  atFrameId: string;
  direction: Direction;
  /** SETTINGS 沿该方向传输，约束的是反方向 encoder / 本方向 decoder 的 header table size。 */
  appliesTo: Direction;
  settingId: number;
  value: string;
  unit: string;
  ackedAtFrameId: string | null;
  basis: JudgmentBasis;
}

export interface TableVersionEvent {
  type: "hpack.table-version";
  id: string;
  direction: Direction;
  version: number;
  atFrameId: string;
  maxSize: number;
  currentSize: number;
  entryCount: number;
  change: "init" | "insert" | "evict" | "size-update" | "settings-cap";
  /** 新增/逐出条目名（供演化视图）。 */
  inserted?: { name: string; value: string };
  evicted?: Array<{ name: string; value: string }>;
  basis: JudgmentBasis;
}

export interface HeaderEvent {
  type: "hpack.header";
  id: string;
  atFrameId: string;
  direction: Direction;
  streamId: number;
  header: HeaderField;
  /** 来源：静态表索引 / 动态表行 / 字面量。 */
  source:
    | { kind: "static"; hpackIndex: number }
    | { kind: "dynamic"; hpackIndex: number; tableVersion: number; insertedAtFrameId: string }
    | { kind: "literal" };
  chainId: string;
  ordinalInChain: number;
  basis: JudgmentBasis;
}

export interface StreamStateEvent {
  type: "stream.state";
  id: string;
  streamId: number;
  atFrameId: string;
  from: StreamState;
  to: StreamState;
  causedByFrameType: string;
  direction: Direction;
  basis: JudgmentBasis;
}

export interface ViolationEvent {
  type: "violation";
  id: string;
  code: string;
  scope: ErrorScope;
  atFrameId: string;
  streamId: number | null;
  message: string;
  earliest: boolean;
  basis: JudgmentBasis;
  candidateId?: string;
  /** 当存在多合法候选时，本违规是否仍被接受（裁定前为 candidate）。 */
  status: "candidate" | "accepted" | "rejected";
}

export interface ContinuationChainEvent {
  type: "continuation.chain";
  id: string;
  streamId: number;
  startFrameId: string;
  fragmentFrameIds: string[];
  complete: boolean;
  /** header block 未结束时夹入其他帧 → 连接错误候选。 */
  interleavedFrameId?: string;
  basis: JudgmentBasis;
}

export interface DiagnosticEvent {
  type: "diagnostic";
  id: string;
  atFrameId: string | null;
  code: string;
  message: string;
  severity: "warning" | "error";
  basis: JudgmentBasis;
}

export type EngineEvent =
  | SettingsEffectiveEvent
  | TableVersionEvent
  | HeaderEvent
  | StreamStateEvent
  | ViolationEvent
  | ContinuationChainEvent
  | DiagnosticEvent;

/** 人工决定（候选切换/接受/否定/参数调整）。 */
export interface DecisionRecord {
  id: string;
  branchId: string;
  seq: number;
  kind: "accept" | "reject" | "select-candidate";
  targetCandidateId: string;
  atFrameId: string;
  note: string;
  basis: JudgmentBasis;
  /** 乐观并发版本。 */
  revision: number;
}

export interface ReplayInput {
  importId: string;
  material: MaterialStore;
  params: BranchParams;
  /** 本分支已采纳的决定（引擎外持久化，按 seq 顺序应用）。 */
  decisions: DecisionRecord[];
  /** 基线/已选候选集：候选若被决定 reject 则不产出 violation。 */
}

/** 来源层材料的只读视图（引擎不允许修改来源）。 */
export interface MaterialStore {
  frames: ParsedFrame[];
}

export interface ReplayOutput {
  events: EngineEvent[];
  /** 按 frameId 聚合的候选违规（多候选合法情形）。 */
  candidates: CandidateGroup[];
  tableSnapshots: Record<Direction, TableSnapshot[]>;
  streamTimeline: Array<StreamStateEvent>;
  earliestViolation: ViolationEvent | null;
}

export interface CandidateGroup {
  atFrameId: string;
  frameId: string;
  question: string;
  candidates: Array<{
    candidateId: string;
    label: string;
    violationCode: string;
    scope: ErrorScope;
    description: string;
    chosen: boolean;
  }>;
}

export interface TableSnapshot {
  atFrameId: string;
  version: number;
  rows: Array<{ name: string; value: string; insertedAtFrameId: string; size: number }>;
  currentSize: number;
  settingsMax: number;
}
