import {
  HpackDecoderContext,
  decodeHeaderBlock,
} from "../protocol/hpack.ts";
import { STATIC_TABLE_SIZE } from "../protocol/static-table.ts";
import { judgeFrame } from "../protocol/stream-fsm.ts";
import type {
  ContinuationChainEvent,
  DiagnosticEvent,
  EngineEvent,
  HeaderEvent,
  ReplayInput,
  ReplayOutput,
  CandidateGroup,
  SettingsEffectiveEvent,
  StreamStateEvent,
  TableVersionEvent,
  ViolationEvent,
} from "./types.ts";
import type {
  Direction,
  HeaderField,
  JudgmentBasis,
  ParsedFrame,
  StreamState,
  Violation,
} from "../protocol/types.ts";

const SETTINGS_HEADER_TABLE_SIZE = 1;
const SETTINGS_MAX_FRAME_SIZE = 5;
const SETTINGS_MAX_CONCURRENT_STREAMS = 3;

/** 稳定事件身份：相同 importId/分支参数与决定下，重放产生相同 id。 */
function evId(parts: Array<string | number>): string {
  return parts.map((p) => String(p)).join(".");
}

function basis(
  ruleId: string,
  ruleVersion: string,
  section: string,
  direction: Direction,
  refs: Record<string, string>,
  dependsOn: string[],
  fact: string,
): JudgmentBasis {
  return { ruleId, ruleVersion, section, direction, refs, dependsOn, fact };
}

interface ActiveChain {
  streamId: number;
  startFrameId: string;
  fragmentFrameIds: string[];
  hex: string;
  direction: Direction;
}

interface StreamRuntime {
  state: StreamState;
  lastFrameId: string | null;
}

interface ReplayRuntime {
  events: EngineEvent[];
  /** 每方向独立的 HPACK 解码上下文——表按方向隔离。 */
  hpack: Record<Direction, HpackDecoderContext>;
  tableVersions: Record<Direction, number>;
  tableSnapshots: ReplayOutput["tableSnapshots"];
  streams: Map<number, StreamRuntime>;
  streamTimeline: StreamStateEvent[];
  /** 各方向最近一次 SETTINGS(HEADER_TABLE_SIZE) 的“通告/生效/ACK”坐标。 */
  pendingTableSize: Record<Direction, { value: number; frameId: string } | null>;
  ackedTableSize: Record<Direction, { value: number; frameId: string } | null>;
  maxFrameSize: number;
  activeChain: ActiveChain | null;
  candidates: CandidateGroup[];
  rejectedCandidateIds: Set<string>;
  selectedCandidateIds: Set<string>;
  decisionsByCandidate: Map<string, { kind: string; decisionSeq: number }>;
  stopped: boolean;
  stopFrameId: string | null;
}

function otherDir(d: Direction): Direction {
  return d === "c2s" ? "s2c" : "c2s";
}

function eventSourceId(f: ParsedFrame): string {
  return `source:${f.frameId}`;
}

export function replay(input: ReplayInput): ReplayOutput {
  const { params, material, decisions } = input;
  const hpack: Record<Direction, HpackDecoderContext> = {
    c2s: new HpackDecoderContext(params.initialDynamicTableSize),
    s2c: new HpackDecoderContext(params.initialDynamicTableSize),
  };
  const rt: ReplayRuntime = {
    events: [],
    hpack,
    tableVersions: { c2s: 0, s2c: 0 },
    tableSnapshots: { c2s: [], s2c: [] },
    streams: new Map(),
    streamTimeline: [],
    pendingTableSize: { c2s: null, s2c: null },
    ackedTableSize: { c2s: null, s2c: null },
    maxFrameSize: params.initialMaxFrameSize,
    activeChain: null,
    candidates: [],
    rejectedCandidateIds: new Set(),
    selectedCandidateIds: new Set(),
    decisionsByCandidate: new Map(),
    stopped: false,
    stopFrameId: null,
  };
  for (const d of decisions) {
    if (d.kind === "reject") rt.rejectedCandidateIds.add(d.targetCandidateId);
    if (d.kind === "select-candidate" || d.kind === "accept") rt.selectedCandidateIds.add(d.targetCandidateId);
    rt.decisionsByCandidate.set(d.targetCandidateId, { kind: d.kind, decisionSeq: d.seq });
  }

  // 两个方向初始动态表版本（各自独立的 v0）。
  (["c2s", "s2c"] as Direction[]).forEach((dir) => {
    emitTableVersion(rt, input, dir, material.frames[0]?.frameId ?? "import-root", "init", undefined);
  });

  for (const frame of material.frames) {
    if (rt.stopped) break;
    processFrame(rt, input, frame);
  }

  // 悬挂的 header block（序列结束仍未 END_HEADERS）。
  if (rt.activeChain && !rt.stopped) {
    const ch = rt.activeChain;
    const ev: ContinuationChainEvent = {
      type: "continuation.chain",
      id: evId(input.importId, "chain", ch.startFrameId),
      streamId: ch.streamId,
      startFrameId: ch.startFrameId,
      fragmentFrameIds: ch.fragmentFrameIds,
      complete: false,
      basis: basis(
        "header-block-incomplete-at-end",
        params.ruleVersion,
        "RFC9113 §8.1",
        ch.direction,
        { startFrame: ch.startFrameId },
        [eventSourceIdFromId(ch.startFrameId)],
        "连接结束时 header block 仍缺 END_HEADERS",
      ),
    };
    rt.events.push(ev);
  }

  const violations = rt.events.filter((e): e is ViolationEvent => e.type === "violation");
  const earliest = violations.find((v) => v.status !== "rejected" && v.earliest) ?? null;
  return {
    events: rt.events,
    candidates: rt.candidates,
    tableSnapshots: rt.tableSnapshots,
    streamTimeline: rt.streamTimeline,
    earliestViolation: earliest,
  };
}

function eventSourceIdFromId(frameId: string): string {
  return `source:${frameId}`;
}
