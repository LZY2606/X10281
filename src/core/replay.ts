// 逐帧回放：输入“来源层”的 RawFrame（字节/方向/坐标），产出“解释层”事件、
// findings、stream 状态、动态表演化。所有结论带依赖节点，供失效范围计算。

import { decodeBlock, HpackTable, type DecodedHeader, type TableSnapshot } from './hpack.ts';
import { ErrorCode, FrameFlags, FrameType, hasFlag, parseFrame, type Direction, type ParsedFrame, type RawFrame } from './frame.ts';
import { DEFAULT_RULE_PACK_VERSION, getRule } from './rules.ts';

export type StreamState = 'idle' | 'open' | 'half-closed(local)' | 'half-closed(remote)' | 'closed';

export type ReplayEventType =
  | 'frame-observed'
  | 'settings-proposed'
  | 'settings-acked'
  | 'settings-applied'
  | 'header-block-open'
  | 'continuation-appended'
  | 'header-block-closed'
  | 'header-decoded'
  | 'dynamic-table-version'
  | 'stream-state-change'
  | 'violation';

export interface DepNode {
  /** 稳定派生身份：d<sha1(内容键) 前 12 位>；导出/删除/导入后稳定 */
  id: string;
  kind: 'event' | 'finding' | 'table-version' | 'dynamic-table-version' | 'header' | 'stream-state';
  /** 直接来源（RawFrame id）与规则版本（ruleId@version） */
  sourceFrameIds: string[];
  ruleRefs: string[];
  /** 上游派生节点 */
  dependsOn: string[];
  payload: Record<string, unknown>;
}

export interface Finding {
  nodeId: string;
  seq: number;
  frameId: string;
  ruleId: string;
  ruleVersion: number;
  scope: 'connection' | 'stream';
  errorCode: number;
  errorName: string;
  streamId?: number;
  message: string;
  /** 输入片段（坐标基准：帧内 octet 区间或 stream id） */
  evidence: { byteRangeOctets?: [number, number]; field?: string; value?: string | number };
  affectedObjectIds: string[];
  /** 未采纳候选也保留：该 finding 对应的候选解释 */
  candidateId?: string;
}

export interface StreamView {
  streamId: number;
  state: StreamState;
  firstFrameId: string;
  lastFrameId: string;
  /** 状态变迁节点 id 列表 */
  history: string[];
}

export interface HeaderBlockView {
  id: string;
  streamId: number;
  direction: Direction;
  startFrameId: string;
  continuationFrameIds: string[];
  endFrameId?: string;
  headers: { nodeId: string; header: DecodedHeader }[];
  tableOutcomes: { maxOctets: number; adopted: boolean; error?: { message: string } }[];
}

export interface SettingsEffectPoint {
  direction: Direction;
  proposedAtSeq?: number;
  ackedAtSeq?: number;
  appliedAtSeq?: number;
  headerTableSizeOctets: number;
  frameId?: string;
}

export interface ReplayResult {
  frames: ParsedFrame[];
  events: DepNode[];
  findings: Finding[];
  earliestViolation?: Finding;
  streams: Record<number, StreamView>;
  headerBlocks: HeaderBlockView[];
  tableEvolution: { direction: Direction; afterSeq: number; frameId: string; snapshot: TableSnapshot }[];
  settingsPoints: SettingsEffectPoint[];
  nodes: Record<string, DepNode>;
  /** 连接错误发生后未继续回放的帧（输入仍保留） */
  notReachedFrameIds: string[];
}

const SETTINGS_HEADER_TABLE_SIZE = 0x1;

function stableId(kind: string, keyParts: (string | number)[]): string {
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const h = crypto.createHash('sha1').update(kind + '|' + keyParts.join('|')).digest('hex').slice(0, 12);
  return `d_${h}`;
}

export function errorName(code: number): string {
  for (const [n, v] of Object.entries(ErrorCode)) if (v === code) return n;
  return `UNKNOWN(0x${code.toString(16)})`;
}

export interface ReplayOptions {
  rulePackVersion?: number;
  /** 材料级输入修订：frameId -> 替换后的 RawFrame（仅这些帧的下游结论失效） */
  rawOverrides?: Record<string, RawFrame>;
}

interface OpenBlock {
  streamId: number;
  direction: Direction;
  startFrameId: string;
  continuationFrameIds: string[];
  fragments: Uint8Array[];
}

interface DirSetting {
  confirmed: number;
  proposed?: number;
  proposedAtSeq?: number;
  proposedFrameId?: string;
}

export function replay(rawFrames: RawFrame[], opts: ReplayOptions = {}): ReplayResult {
  const ruleVersion = opts.rulePackVersion ?? DEFAULT_RULE_PACK_VERSION;
  const frames = rawFrames.map((rf, seq) => {
    const eff = opts.rawOverrides?.[rf.id] ?? rf;
    const bytes = new Uint8Array(Buffer.from(eff.bytesHex, 'hex'));
    return parseFrame(bytes, eff.direction, seq, eff.offsetOctets, eff.id);
  });

  const events: DepNode[] = [];
  const findings: Finding[] = [];
  const nodes: Record<string, DepNode> = {};
  const streams: Record<number, StreamView> = {};
  const headerBlocks: HeaderBlockView[] = [];
  const tableEvolution: ReplayResult['tableEvolution'] = [];
  const settingsPoints: SettingsEffectPoint[] = [];
  const notReachedFrameIds: string[] = [];

  const tables: Record<Direction, HpackTable> = {
    c2s: new HpackTable('c2s', 4096),
    s2c: new HpackTable('s2c', 4096),
  };
  // 每方向：对端确认给本端的表上限。键为“块流动方向”。
  const dirSetting: Record<Direction, DirSetting> = {
    c2s: { confirmed: 4096 },
    s2c: { confirmed: 4096 },
  };
  // SETTINGS 交换跟踪：ACK 必须对应已收到的非 ACK SETTINGS（按方向）
  const pendingAck: Record<Direction, boolean> = { c2s: false, s2c: false };
  let openBlock: OpenBlock | null = null;
  let connectionError = false;

  function addNode(kind: DepNode['kind'], keyParts: (string | number)[], sourceFrameIds: string[], ruleRefs: string[], dependsOn: string[], payload: Record<string, unknown>): DepNode {
    const id = stableId(kind, [...keyParts, ...sourceFrameIds, ...ruleRefs, ...dependsOn]);
    const existing = nodes[id];
    if (existing) return existing;
    const node: DepNode = { id, kind, sourceFrameIds, ruleRefs, dependsOn, payload };
    nodes[id] = node;
    events.push(node);
    return node;
  }

  function addFinding(frameId: string, seq: number, ruleId: string, message: string, streamId: number | undefined, evidence: Finding['evidence'], candidateId?: string, scopeOverride?: 'connection' | 'stream', errorCodeOverride?: number): Finding {
    const rule = getRule(ruleId, ruleVersion);
    const scope = scopeOverride ?? (rule.scope === 'conditional' ? 'connection' : rule.scope);
    const errorCode = errorCodeOverride ?? rule.errorCode;
    const affected: string[] = [];
    if (streamId !== undefined && streams[streamId]) affected.push(`stream:${streamId}`);
    affected.push(`direction-table:${frames[seq]!.raw.direction}`);
    const node = addNode('finding', [ruleId, scope, message, String(streamId ?? '-'), evidence.field ?? '-', String(evidence.byteRangeOctets?.[0] ?? '-'), candidateId ?? '-'], [frameId], [`${ruleId}@${rule.version}`], [], { ruleId, scope, errorCode, streamId, message, evidence, candidateId });
    const f: Finding = { nodeId: node.id, seq, frameId, ruleId, ruleVersion: rule.version, scope, errorCode, errorName: errorName(errorCode), streamId, message, evidence, affectedObjectIds: affected, candidateId };
    findings.push(f);
    node.payload.finding = f;
    return f;
  }

  function setState(streamId: number, next: StreamState, frameId: string, seq: number): void {
    const prev = streams[streamId] ?? { streamId, state: 'idle' as StreamState, firstFrameId: frameId, lastFrameId: frameId, history: [] };
    if (prev.state === next) {
      prev.lastFrameId = frameId;
      streams[streamId] = prev;
      return;
    }
    const node = addNode('stream-state', [String(streamId), prev.state, next, String(seq)], [frameId], [], prev.history, { streamId, from: prev.state, to: next, seq });
    prev.history.push(node.id);
    prev.state = next;
    prev.lastFrameId = frameId;
    streams[streamId] = prev;
  }

  function snapshotTable(dir: Direction, frameId: string, seq: number): void {
    const node = addNode('table-version', [dir, String(seq), String(tables[dir]!.version)], [frameId], [], [], { direction: dir, snapshot: tables[dir]!.snapshot(), seq });
    tableEvolution.push({ direction: dir, afterSeq: seq, frameId, snapshot: tables[dir]!.snapshot() });
    void node;
  }

  for (let seq = 0; seq < frames.length; seq++) {
    const pf = frames[seq]!;
    const { raw, header, body } = pf;
    const dir = raw.direction;
    const peer: Direction = dir === 'c2s' ? 's2c' : 'c2s';

    addNode('event', ['frame-observed', String(seq)], [raw.id], [], [], { seq, type: body.kind, flags: header.flags, streamId: header.streamId, rBit: header.rBit, offsetOctets: raw.offsetOctets, direction: dir, lengthOctets: header.length, parseDiagnostics: pf.parseDiagnostics });

    if (connectionError) {
      notReachedFrameIds.push(raw.id);
      continue;
    }

    // header block 未闭合时，其它帧的合法性按协议裁决（RFC 7540 §6.10）
    if (openBlock && body.kind !== 'CONTINUATION') {
      addFinding(raw.id, seq, 'R-HEADERBLOCK-CONTIGUITY', `并发 header block：stream ${openBlock.streamId} 的 header block 未收到 END_HEADERS，期间出现 ${body.kind} 帧（${dir}）`, openBlock.streamId, { field: 'intervening-frame', value: body.kind });
      connectionError = true;
      notReachedFrameIds.push(raw.id);
      continue;
    }

    // R 位 / stream id 穷尽（RFC 7540 §5.1.1）
    if (header.rBit) {
      addFinding(raw.id, seq, 'R-STREAM-EXHAUST', 'R 位置位：stream identifier 的保留位必须为 0（越出 31-bit 坐标基准）', undefined, { field: 'R', value: 1 });
      connectionError = true;
      notReachedFrameIds.push(raw.id);
      continue;
    }
    if (header.streamId === 0x7fffffff && body.kind === 'HEADERS') {
      addFinding(raw.id, seq, 'R-STREAM-EXHAUST', `stream id 穷尽：HEADERS 使用最大标识符 ${header.streamId} 后本方向再无可分配 id（ENHANCE_YOUR_CALM）`, header.streamId, { field: 'stream-id', value: header.streamId }, undefined, 'connection', ErrorCode.ENHANCE_YOUR_CALM);
      connectionError = true;
      notReachedFrameIds.push(raw.id);
      continue;
    }

    switch (body.kind) {
      case 'SETTINGS': {
        if (header.streamId !== 0) {
          addFinding(raw.id, seq, 'R-STREAM-IDENTIFIER-ZERO', 'SETTINGS 必须使用 stream id 0', header.streamId, { field: 'stream-id', value: header.streamId });
          connectionError = true;
          break;
        }
        if (body.ack) {
          if (!pendingAck[peer]) {
            addFinding(raw.id, seq, 'R-SETTINGS-ACK', `SETTINGS ACK 时机错误：${dir} 收到的 ACK 没有对应的未确认 SETTINGS`, undefined, { field: 'settings-ack', value: 'unsolicited' });
            connectionError = true;
            break;
          }
          pendingAck[peer] = false;
          const ps = dirSetting[dir];
          if (ps.proposed !== undefined) {
            ps.confirmed = ps.proposed;
            ps.proposed = undefined;
            addNode('event', ['settings-applied', String(seq), dir], [raw.id], [`R-SETTINGS-ACK@${getRule('R-SETTINGS-ACK', ruleVersion).version}`], [], { direction: dir, headerTableSizeOctets: ps.confirmed, ackedAtSeq: seq });
            settingsPoints.push({ direction: dir, appliedAtSeq: seq, ackedAtSeq: seq, headerTableSizeOctets: ps.confirmed, frameId: raw.id });
          }
        } else {
          if (pendingAck[dir]) {
            addFinding(raw.id, seq, 'R-SETTINGS-ACK', `SETTINGS 时机错误：${dir} 上一个 SETTINGS 尚未被 ACK 就再次发送`, undefined, { field: 'settings', value: 'repeated-before-ack' });
          }
          pendingAck[dir] = true;
          for (const p of body.params) {
            if (p.id === SETTINGS_HEADER_TABLE_SIZE) {
              // 接收方在其读取方向（peer 流）上提议新上限；发送方在 ACK 生效点后采用
              const ps = dirSetting[dir];
              ps.proposed = p.value;
              ps.proposedAtSeq = seq;
              ps.proposedFrameId = raw.id;
              addNode('event', ['settings-proposed', String(seq), dir], [raw.id], [`R-SETTINGS-ACK@${getRule('R-SETTINGS-ACK', ruleVersion).version}`, `R-HPACK-SIZE-LIMIT@${getRule('R-HPACK-SIZE-LIMIT', ruleVersion).version}`], [], { direction: dir, headerTableSizeOctets: p.value, proposedAtSeq: seq });
              settingsPoints.push({ direction: dir, proposedAtSeq: seq, headerTableSizeOctets: p.value, frameId: raw.id });
            }
          }
        }
        break;
      }

      case 'HEADERS': {
        if (header.streamId === 0) {
          addFinding(raw.id, seq, 'R-STREAM-IDENTIFIER-ZERO', 'HEADERS 不得使用 stream id 0', 0, { field: 'stream-id', value: 0 });
          connectionError = true;
          break;
        }
        const st = streams[header.streamId]?.state ?? 'idle';
        if (st === 'closed') {
          addFinding(raw.id, seq, 'R-STREAM-REUSE', `stream ${header.streamId} 已关闭后又收到 HEADERS（id 复用）`, header.streamId, { field: 'stream-state', value: st });
          break;
        }
        if (st === `half-closed(${dir === 'c2s' ? 'local' : 'remote'})`) {
          addFinding(raw.id, seq, 'R-HALF-CLOSED-DIRECTION', `方向表混淆：${dir} 在 half-closed 状态下再发 HEADERS（stream ${header.streamId}）`, header.streamId, { field: 'stream-state', value: st });
          break;
        }
        if (body.padLength !== undefined && body.padLength >= header.length) {
          addFinding(raw.id, seq, 'R-PADDING', `padding 越界：pad length ${body.padLength} octets 不小于可容纳载荷 ${header.length} octets（${dir} stream ${header.streamId}）`, header.streamId, { byteRangeOctets: [0, 1], field: 'pad-length', value: body.padLength });
          connectionError = true;
          break;
        }
        if (pf.parseDiagnostics.some((d) => d.startsWith('padding overflow'))) {
          addFinding(raw.id, seq, 'R-PADDING', `padding 越界：HEADERS pad length 超过载荷（stream ${header.streamId}）`, header.streamId, { field: 'pad-length', value: body.padLength ?? -1 });
          connectionError = true;
          break;
        }
        setState(header.streamId, st === 'idle' ? 'open' : st, raw.id, seq);
        openBlock = { streamId: header.streamId, direction: dir, startFrameId: raw.id, continuationFrameIds: [], fragments: [new Uint8Array(Buffer.from(body.fragmentHex, 'hex'))] };
        addNode('event', ['header-block-open', String(seq), String(header.streamId), dir], [raw.id], ['R-CONTINUATION-STREAM@1'], [], { streamId: header.streamId, direction: dir, fragmentOctets: body.fragmentHex.length / 2 });
        if (hasFlag(header.flags, FrameFlags.END_HEADERS)) closeBlock(seq);
        break;
      }

      case 'CONTINUATION': {
        if (!openBlock) {
          addFinding(raw.id, seq, 'R-CONTINUATION-STREAM', `CONTINUATION 没有可延续的 header block（stream ${header.streamId}）`, header.streamId, { field: 'continuation', value: 'orphan' });
          connectionError = true;
          break;
        }
        if (openBlock.streamId !== header.streamId || openBlock.direction !== dir) {
          addFinding(raw.id, seq, 'R-CONTINUATION-STREAM', `CONTINUATION 链混淆：延续 ${openBlock.streamId}/${openBlock.direction} 却收到 ${header.streamId}/${dir}`, header.streamId, { field: 'continuation', value: 'mismatch' });
          connectionError = true;
          break;
        }
        openBlock.continuationFrameIds.push(raw.id);
        openBlock.fragments.push(new Uint8Array(Buffer.from(body.fragmentHex, 'hex')));
        addNode('event', ['continuation-appended', String(seq), String(header.streamId)], [raw.id], ['R-CONTINUATION-STREAM@1'], [], { streamId: header.streamId, fragmentOctets: body.fragmentHex.length / 2 });
        if (hasFlag(header.flags, FrameFlags.END_HEADERS)) closeBlock(seq);
        break;
      }

      case 'DATA': {
        const st = streams[header.streamId]?.state ?? 'idle';
        if (header.streamId === 0) {
          addFinding(raw.id, seq, 'R-STREAM-IDENTIFIER-ZERO', 'DATA 不得使用 stream id 0', 0, { field: 'stream-id', value: 0 });
          connectionError = true;
          break;
        }
        if (st === 'idle' || st === 'closed') {
          addFinding(raw.id, seq, 'R-STREAM-REUSE', `DATA 出现在 ${st} 状态的 stream ${header.streamId}`, header.streamId, { field: 'stream-state', value: st });
          break;
        }
        if (st === `half-closed(${dir === 'c2s' ? 'local' : 'remote'})`) {
          addFinding(raw.id, seq, 'R-HALF-CLOSED-DIRECTION', `方向表混淆：${dir} 在 half-closed 后仍发送 DATA（stream ${header.streamId}）`, header.streamId, { field: 'stream-state', value: st });
          break;
        }
        if (pf.parseDiagnostics.some((d) => d.startsWith('padding overflow')) || (body.padLength !== undefined && body.padLength >= header.length)) {
          addFinding(raw.id, seq, 'R-PADDING', `padding 越界：DATA pad length ${body.padLength} octets 超过载荷 ${header.length} octets（stream ${header.streamId}）`, header.streamId, { field: 'pad-length', value: body.padLength ?? -1 });
          connectionError = true;
          break;
        }
        if (hasFlag(header.flags, FrameFlags.END_STREAM)) setState(header.streamId, dir === 'c2s' ? 'half-closed(local)' : 'half-closed(remote)', raw.id, seq);
        break;
      }

      case 'RST_STREAM': {
        if (header.streamId === 0) {
          addFinding(raw.id, seq, 'R-STREAM-IDENTIFIER-ZERO', 'RST_STREAM 不得使用 stream id 0', 0, { field: 'stream-id', value: 0 });
          connectionError = true;
          break;
        }
        const st = streams[header.streamId]?.state ?? 'idle';
        if (st === 'idle') {
          addFinding(raw.id, seq, 'R-STREAM-REUSE', `RST_STREAM 发往从未打开的 stream ${header.streamId}`, header.streamId, { field: 'stream-state', value: st });
          break;
        }
        setState(header.streamId, 'closed', raw.id, seq);
        break;
      }

      case 'PRIORITY':
      case 'PING':
      case 'GOAWAY':
      case 'WINDOW_UPDATE':
        break;

      default:
        if (pf.parseDiagnostics.length > 0) {
          addFinding(raw.id, seq, 'R-HEADERBLOCK-CONTIGUITY', `无法识别/损坏的帧类型 0x${header.type.toString(16)}，原字节已保留`, header.streamId, { field: 'frame-type', value: header.type });
        }
        break;
    }
  }

  function closeBlock(seq: number): void {
    const block = openBlock!;
    const pf = frames[seq]!;
    const table = tables[block.direction]!;
    const setting = dirSetting[block.direction]!;
    const candidates = setting.proposed !== undefined && setting.proposed !== setting.confirmed ? [setting.proposed] : [];
    const blockBytes = concat(block.fragments);
    let decoded;
    try {
      decoded = decodeBlock(table, blockBytes, { confirmedMaxOctets: setting.confirmed, candidateMaxOctets: candidates, blockSeq: headerBlocks.length });
    } catch (e) {
      addFinding(pf.raw.id, seq, 'R-HPACK-INDEX', `header block 解码失败：${(e as Error).message}`, block.streamId, { field: 'hpack', value: (e as Error).message });
      connectionError = true;
      openBlock = null;
      return;
    }

    const adopted = decoded.outcomes.find((o) => o.adopted && !o.error) ?? decoded.outcomes.find((o) => o.adopted)!;
    const view: HeaderBlockView = {
      id: stableId('header-block', [block.startFrameId, String(block.streamId), block.direction]),
      streamId: block.streamId,
      direction: block.direction,
      startFrameId: block.startFrameId,
      continuationFrameIds: block.continuationFrameIds,
      endFrameId: pf.raw.id,
      headers: [],
      tableOutcomes: decoded.outcomes.map((o) => ({ maxOctets: o.maxOctets, adopted: o.adopted, error: o.error ? { message: o.error.message } : undefined })),
    };

    for (const o of decoded.outcomes) {
      if (o.error) {
        const code = o.error.code === 'TABLE_SIZE_UPDATE' ? 'R-HPACK-SIZE-LIMIT' : 'R-HPACK-INDEX';
        addFinding(pf.raw.id, seq, code, `${o.error.message}（候选上限 ${o.maxOctets} octets${o.adopted ? '，已采纳' : '，未采纳'}）`, block.streamId, { field: 'hpack', value: o.error.message }, `limit-${o.maxOctets}`, 'connection', o.error.code === 'TABLE_SIZE_UPDATE' ? ErrorCode.COMPRESSION_ERROR : ErrorCode.COMPRESSION_ERROR);
      }
    }

    for (const h of adopted.headers) {
      const n = addNode('header', [block.startFrameId, String(h.ordinal), h.origin.kind], [block.startFrameId, ...block.continuationFrameIds, pf.raw.id], ['R-HPACK-DIRECTION@1'], [], { header: h, direction: block.direction, tableVersion: table.version, blockSeq: headerBlocks.length, notAdoptedCandidates: decoded.outcomes.filter((o) => !o.adopted).map((o) => o.maxOctets) });
      view.headers.push({ nodeId: n.id, header: h });
    }

    // 采纳候选推进动态表（未采纳候选的快照仍随 outcome 保留，可追溯）
    if (adopted) {
      const adv = decoded.outcomes.indexOf(adopted);
      table.version = adopted.snapshot.version;
      // 重建 entries：直接采用候选表快照重建内部表
      adoptOutcome(table, adopted.snapshot);
      const tv = addNode('dynamic-table-version', [block.direction, String(seq), String(adopted.snapshot.version)], [block.startFrameId, pf.raw.id], ['R-HPACK-DIRECTION@1', `R-HPACK-SIZE-LIMIT@${getRule('R-HPACK-SIZE-LIMIT', ruleVersion).version}`], [], { direction: block.direction, snapshot: adopted.snapshot });
      tableEvolution.push({ direction: block.direction, afterSeq: seq, frameId: pf.raw.id, snapshot: adopted.snapshot });
      void tv;
      void adv;
    }

    const endState = hasFlag(pf.header.flags, FrameFlags.END_STREAM)
      ? (block.direction === 'c2s' ? 'half-closed(local)' : 'half-closed(remote)')
      : (streams[block.streamId]?.state ?? 'open');
    setState(block.streamId, endState === 'idle' ? 'open' : endState, pf.raw.id, seq);

    addNode('event', ['header-block-closed', String(seq), String(block.streamId)], [block.startFrameId, ...block.continuationFrameIds, pf.raw.id], ['R-HEADERBLOCK-CONTIGUITY@1', 'R-HPACK-DIRECTION@1'], [], { streamId: block.streamId, headerCount: view.headers.length, bytesOctets: blockBytes.length });
    headerBlocks.push(view);
    openBlock = null;
  }

  function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function adoptOutcome(table: HpackTable, snapshot: TableSnapshot): void {
    const fresh = new HpackTable(snapshot.entries.length ? table.direction : table.direction, snapshot.maxOctets);
    // 通过内部等价重建：逐条插入逆序，保证最新项在前
    table.maxOctets = snapshot.maxOctets;
    table.version = snapshot.version;
    for (let i = snapshot.entries.length - 1; i >= 0; i--) {
      const e = snapshot.entries[i]!;
      table.insert({ name: e.name, value: e.value }, e.insertedByBlockSeq);
    }
    table.version = snapshot.version;
    void fresh;
  }

  const earliestViolation = findings.filter((f) => f.scope === 'connection' || f.scope === 'stream').sort((a, b) => a.seq - b.seq)[0];
  return { frames, events, findings, earliestViolation, streams, headerBlocks, tableEvolution, settingsPoints, nodes, notReachedFrameIds };
}

/** 依赖失效范围：给定来源帧或规则版本变化，返回受影响的派生节点 id */
export function affectedNodes(result: ReplayResult, changedFrameIds: string[], changedRuleIds: string[]): string[] {
  const dirty = new Set<string>();
  const queue: string[] = [];
  for (const node of Object.values(result.nodes)) {
    if (node.sourceFrameIds.some((id) => changedFrameIds.includes(id))) queue.push(node.id);
    if (node.ruleRefs.some((ref) => changedRuleIds.some((r) => ref.startsWith(r + '@')))) queue.push(node.id);
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (dirty.has(id)) continue;
    dirty.add(id);
    for (const node of Object.values(result.nodes)) {
      if (node.dependsOn.includes(id) && !dirty.has(node.id)) queue.push(node.id);
    }
  }
  return [...dirty];
}
