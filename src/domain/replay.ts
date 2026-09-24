/**
 * 逐帧回放器：帧序列 + 连接设置 ->
 *   SETTINGS 生效点 / CONTINUATION 链 / 按方向隔离的动态表版本 /
 *   header block 重建 / stream 状态机 / 最早协议违约 / 多候选。
 *
 * 分析模式：出现连接错误后继续回放，保证后续情形可被观察；
 * 只有某方向 HPACK 索引类错误会令该方向解码器停摆（规则 HPACK_INDEX_BOUNDS）。
 */
import {
  parseFrame,
  FRAME_TYPE as FT,
  FLAG,
  type FrameDirection,
  type KnownDirection,
  type ParsedFrame,
} from './frames.ts';
import {
  DynamicTable,
  decodeHeaderBlock,
  type DecodedField,
  type TableEntry,
} from './hpack.ts';
import { q, BASIS, UNIT } from './units.ts';
import {
  frameSlug,
  blockSlug,
  tableVersionSlug,
  streamSlug,
  violationSlug,
  candidateSlug,
} from './ids.ts';
import { ruleRef, DEFAULT_PARAMS, type ReplayParams } from './rules.ts';

export interface FrameInput {
  seq: number;
  direction: FrameDirection;
  rawHex: string;
  /** 可选真实时间（ns），坐标基准 wire-arrival */
  arrivalNs?: number | null;
}

export interface TableVersionRecord {
  slug: string;
  uuid?: string;
  direction: KnownDirection;
  version: number;
  entries: { name: string; value: string; entrySize: { v: number; u: string; b: string } }[];
  size: { v: number; u: string; b: string };
  maxSize: { v: number; u: string; b: string };
  causedByFrameSeq: number | null;
  causedByFrameSlug: string | null;
  ruleRef: { id: string; version: string };
}

export interface HeaderFieldView {
  index: number;
  name: string | null;
  value: string | null;
  nameRawHex: string;
  valueRawHex: string;
  origin: DecodedField['origin'];
  refIndex: number | null;
  refTableVersionSlug: string | null;
  addedTableVersionSlug: string | null;
  diagnostics: string[];
}

export interface HeaderBlockView {
  slug: string;
  streamId: number;
  direction: FrameDirection;
  startFrameSeq: number;
  endFrameSeq: number;
  frameSeqs: number[];
  continuationChainId: string;
  complete: boolean;
  blockHex: string;
  fields: HeaderFieldView[];
  decoded: boolean;
  diagnostics: { code: string; message: string; frameSeq?: number }[];
}

export type StreamState =
  | 'idle'
  | 'open'
  | 'half_closed_local'
  | 'half_closed_remote'
  | 'closed';

export interface StreamTransition {
  atFrameSeq: number;
  frameSlug: string;
  direction: FrameDirection;
  frameType: string;
  from: StreamState;
  to: StreamState;
  note: string;
}

export interface StreamRecord {
  slug: string;
  streamId: number;
  state: StreamState;
  openedBySeq: number | null;
  transitions: StreamTransition[];
}

export interface ViolationView {
  slug: string;
  frameSeq: number;
  frameSlug: string;
  direction: FrameDirection;
  streamId: number | null;
  scope: 'connection' | 'stream';
  code: string;
  httpError: string;
  message: string;
  rule: { id: string; version: string; basis: Record<string, unknown> };
  affected: string[];
}

export interface CandidateOption {
  key: string;
  direction: KnownDirection;
  fields: { name: string | null; value: string | null; rawHex: string; refTableVersionSlug: string | null }[];
  refTableVersionSlug: string | null;
}

export interface CandidateView {
  slug: string;
  kind: 'direction-table';
  frameSeq: number;
  frameSlug: string;
  streamId: number;
  status: 'pending' | 'accepted';
  options: CandidateOption[];
  rule: { id: string; version: string };
}

export interface SettingsEffectPoint {
  frameSeq: number;
  frameSlug: string;
  direction: FrameDirection;
  headerTableSize: number;
  receivedSeq: number;
  ackedSeq: number | null;
  effectiveSeqOnReceipt: number;
  effectiveSeqOnAck: number | null;
  appliedAtSeq: number | null;
}

export interface FrameView {
  seq: number;
  slug: string;
  direction: FrameDirection;
  rawHex: string;
  rawLengthBytes: number;
  type: number;
  typeName: string;
  flags: number;
  streamId: number;
  streamIdRaw: number;
  arrival: { v: number; u: string; b: string } | null;
  byteOffset: { v: number; u: string; b: string };
  endStream: boolean;
  endHeaders: boolean;
  diagnostics: { code: string; message: string }[];
  violationSlugs: string[];
  blockSlug: string | null;
  continuationRole: 'start' | 'cont' | 'solo' | null;
  chainId: string | null;
  appliedToState: boolean;
  note: string | null;
}
