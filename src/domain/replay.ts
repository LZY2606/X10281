import type { ParsedTrace, ParsedFrame, Direction } from "./frames.ts";
import { FLAGS, FRAME_TYPES } from "./frames.ts";
import { DynamicTable, decodeBlock, type DecodedHeader, type HpackError } from "./hpack.ts";
import { decodeSettingsPayload, type TableSizeEffect } from "./settings.ts";
import { applyFrame, initiatorForStreamId, senderOf, type StreamState, type TransitionResult } from "./stream.ts";
import { RULE_BUNDLES, type RuleBundle } from "./rules.ts";
import { fnv1a64 } from "./ids.ts";

export type ErrorScope = "connection" | "stream";
export type EventKind =
  | "frame-received"
  | "settings-offer"
  | "settings-effective"
  | "settings-ack"
  | "continuation-chain"
  | "header-block"
  | "hpack-table-version"
  | "stream-transition"
  | "protocol-violation"
  | "diagnostic"
  | "candidate-group"
  | "candidate"
  | "decision";

export interface ReplayEvidence {
  ruleId: string;
  spec: "RFC9113" | "RFC7541";
  section: string;
  text: string;
}

export interface ReplayEvent {
  id: string;
  kind: EventKind;
  order: number;
  frameId?: string;
  frameOrder?: number;
  direction?: Direction;
  streamId?: number;
  label: string;
  coords?: FrameCoords;
  value?: Record<string, unknown>;
  evidence?: ReplayEvidence[];
  scope?: ErrorScope;
  errorCode?: string;
  dependsOn: string[];
  tableVersion?: number;
  tableDirection?: Direction;
}

export interface FrameCoords {
  line: number;
  colStart: number;
  colEnd: number;
  payloadOffset?: number;
  payloadLength?: number;
}

export interface CandidateOption {
  id: string;
  value: "receipt" | "ack";
  label: string;
  preferred: boolean;
  evidence: ReplayEvidence[];
}

export interface CandidateGroup {
  id: string;
  frameOrder: number;
  frameId: string;
  subject: string;
  parameter: "headerTableSizeEffect";
  options: CandidateOption[];
}

export interface HeaderBlockRecord {
  id: string;
  startFrameId: string;
  continuationFrameIds: string[];
  endFrameId: string;
  direction: Direction;
  streamId: number;
  headerOrder: number;
  headers: DecodedHeader[];
  error?: HpackError;
  encoderLimitAtBlock: number;
  limitSourceFrameId?: string;
  tableVersionBefore: number;
  tableVersionAfter: number;
  byteLength: number;
}

export interface StreamSnapshot {
  streamId: number;
  state: StreamState;
  initiator: "client" | "server" | null;
  lastFrameId?: string;
  history: { frameId: string; order: number; transition: TransitionResult }[];
  seenOffers: number[];
}

export interface ViolationRecord {
  eventId: string;
  order: number;
  frameId?: string;
  direction?: Direction;
  streamId?: number;
  scope: ErrorScope;
  errorCode: string;
  message: string;
  ruleId: string;
  affectedObject: string;
  coords?: FrameCoords;
}

export interface ReplayParams {
  ruleVersion: string;
  headerTableSizeEffect: TableSizeEffect;
  decisions?: Record<string, string>;
}

export interface ReplayRun {
  runId: string;
  params: ReplayParams;
  events: ReplayEvent[];
  headerBlocks: HeaderBlockRecord[];
  streams: Record<number, StreamSnapshot>;
  violations: ViolationRecord[];
  earliestViolation?: ViolationRecord;
  candidates: CandidateGroup[];
  tables: {
    c2s: TableSummary;
    s2c: TableSummary;
  };
  tableTimeline: { order: number; frameId: string; direction: Direction; c2sVersion: number; s2cVersion: number }[];
}

export interface TableSummary {
  maxSize: number;
  version: number;
  size: number;
  entries: { name: string; value: string; size: number; insertOrder: number; insertedByFrameId: string }[];
}

export function defaultReplayParams(ruleVersion: string = Object.keys(RULE_BUNDLES)[0]): ReplayParams {
  return { ruleVersion, headerTableSizeEffect: "undetermined", decisions: {} };
}

export function runIdFor(params: ReplayParams, materialId: string): string {
  const decisions = Object.entries(params.decisions ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `run_${fnv1a64([materialId, params.ruleVersion, params.headerTableSizeEffect, decisions].join("\u0001"))}`;
}

export function canonicalEffect(params: ReplayParams, rules: RuleBundle, candidates: CandidateGroup[]): "receipt" | "ack" {
  if (params.headerTableSizeEffect === "receipt" || params.headerTableSizeEffect === "ack") return params.headerTableSizeEffect;
  for (const group of candidates) {
    const chosen = params.decisions?.[group.id];
    if (chosen) {
      const option = group.options.find((o) => o.id === chosen);
      if (option) return option.value;
    }
  }
  return rules.defaults.headerTableSizeEffect;
}

const DEFAULT_TABLE_SIZE = 4096;

interface DirectionRuntime {
  table: DynamicTable;
  encoderLimit: number;
  encoderLimitSourceFrameId?: string;
  offers: { frame: ParsedFrame; tableSize: number; ackedBy?: ParsedFrame }[];
}
