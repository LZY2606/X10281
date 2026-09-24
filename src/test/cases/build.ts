// 离线领域案例包生成器：产出的不是通用表格，而是带 HTTP/2 领域注释的
// 帧序列（原帧字节/方向/坐标/单位）。生成结果提交到 cases/*.json。
import { buildFrame, FrameFlags, FrameType, toHex, type Direction, type RawFrame } from '../../core/frame.ts';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface FrameSpec {
  note: string;
  direction: Direction;
  bytes: Uint8Array;
}

const seqHex = (arr: number[]): Uint8Array => new Uint8Array(arr);

function settings(ack: boolean, headerTableSize?: number): Uint8Array {
  const params: number[] = [];
  if (headerTableSize !== undefined) params.push(0x00, 0x01, (headerTableSize >>> 24) & 255, (headerTableSize >>> 16) & 255, (headerTableSize >>> 8) & 255, headerTableSize & 255);
  return buildFrame(FrameType.SETTINGS, ack ? FrameFlags.ACK : 0, 0, new Uint8Array(params));
}

function indexedHeaderBlock(indexes: number[]): Uint8Array {
  // HPACK 带 7 位前缀的索引表示（index < 127 时单字节 0x80|i）
  return new Uint8Array(indexes.map((i) => 0x80 | i));
}

function literalIncremental(nameIndex: number, value: string): Uint8Array {
  const v = Buffer.from(value, 'utf8');
  const out = new Uint8Array(2 + v.length);
  out[0] = 0x40 | nameIndex;
  out[1] = v.length;
  out.set(v, 2);
  return out;
}

function headers(streamId: number, block: Uint8Array, flags: number = FrameFlags.END_HEADERS, opts: { padLength?: number; endStream?: boolean } = {}): Uint8Array {
  let f = flags;
  if (opts.endStream) f |= FrameFlags.END_STREAM;
  let payload = block;
  if (opts.padLength !== undefined) {
    const p = new Uint8Array(1 + block.length + opts.padLength);
    p[0] = opts.padLength;
    p.set(block, 1);
    payload = p;
    f |= FrameFlags.PADDED;
  }
  return buildFrame(FrameType.HEADERS, f, streamId, payload);
}

function continuation(streamId: number, block: Uint8Array, endHeaders = true): Uint8Array {
  return buildFrame(FrameType.CONTINUATION, endHeaders ? FrameFlags.END_HEADERS : 0, streamId, block);
}

function data(streamId: number, body: number[], endStream: boolean, padLength?: number): Uint8Array {
  let payload = new Uint8Array(body);
  let flags = endStream ? FrameFlags.END_STREAM : 0;
  if (padLength !== undefined) {
    const p = new Uint8Array(1 + body.length + padLength);
    p[0] = padLength;
    p.set(body, 1);
    payload = p;
    flags |= FrameFlags.PADDED;
  }
  return buildFrame(FrameType.DATA, flags, streamId, payload);
}

function rst(streamId: number, code: number): Uint8Array {
  return buildFrame(FrameType.RST_STREAM, 0, streamId, new Uint8Array([(code >>> 24) & 255, (code >>> 16) & 255, (code >>> 8) & 255, code & 255]));
}

function raw(type: number, flags: number, streamId: number, payload: number[]): Uint8Array {
  const p = new Uint8Array(payload);
  const out = new Uint8Array(9 + p.length);
  out[0] = (p.length >> 16) & 0xff;
  out[1] = (p.length >> 8) & 0xff;
  out[2] = p.length & 0xff;
  out[3] = type;
  out[4] = flags;
  // 不掩码 R 位：案例需要构造保留位置位的原始帧
  out[5] = (streamId >>> 24) & 0xff;
  out[6] = (streamId >>> 16) & 0xff;
  out[7] = (streamId >>> 8) & 0xff;
  out[8] = streamId & 0xff;
  out.set(p, 9);
  return out;
}

function toRawFrames(specs: FrameSpec[]): RawFrame[] {
  const perDir: Record<Direction, number> = { c2s: 0, s2c: 0 };
  return specs.map((s, seq) => {
    const offset = perDir[s.direction];
    perDir[s.direction] += s.bytes.length;
    return { id: `f${offset}_${s.direction}`, bytesHex: toHex(s.bytes), direction: s.direction, offsetOctets: offset, seq };
  });
}

// 基线：一次合规的 c2s GET，含 SETTINGS 交换（4096→256 octet 的 HEADER_TABLE_SIZE）、
// CONTINUATION 链、动态表插入、DATA END_STREAM。所有反例只改动其中一个直接来源。
function baseline(): FrameSpec[] {
  return [
    { note: 'client SETTINGS：提议 c2s 方向 HEADER_TABLE_SIZE=256 octets（生效点待 ACK）', direction: 'c2s', bytes: settings(false, 256) },
    { note: 'server SETTINGS：s2c 方向保持默认（空 SETTINGS）', direction: 's2c', bytes: settings(false) },
    { note: 'server ACK client SETTINGS → c2s 256 octet 上限生效', direction: 's2c', bytes: settings(true) },
    { note: 'client ACK server SETTINGS', direction: 'c2s', bytes: settings(true) },
    { note: 'HEADERS stream 1 起始：:method GET(idx2) :scheme https(idx61) :path /(idx1) + 字面 x-trace 入动态表，无 END_HEADERS', direction: 'c2s', bytes: headers(1, concatBytes(indexedHeaderBlock([2, 61, 1]), literalIncremental(20, 'abc-123')), 0) },
    { note: 'CONTINUATION stream 1 收尾：:authority 索引 idx1 + END_HEADERS', direction: 'c2s', bytes: continuation(1, indexedHeaderBlock([1])) },
    { note: 'DATA stream 1 空体 + END_STREAM → half-closed(local)', direction: 'c2s', bytes: data(1, [], true) },
    { note: 'server HEADERS stream 1 响应（:status 200 idx4），s2c 独立动态表', direction: 's2c', bytes: headers(1, indexedHeaderBlock([4]), FrameFlags.END_HEADERS) },
    { note: 'server DATA + END_STREAM → stream closed', direction: 's2c', bytes: data(1, [0x6f, 0x6b], true) },
  ];
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// 变体：仅替换一个直接来源帧（mutates 指向 baseline 帧偏移与方向）
interface CaseDef {
  caseId: string;
  title: string;
  mutates?: { frameOffsetOctets: number; direction: Direction; replacementNote: string } | null;
  expects: { ruleId: string; scope: 'connection' | 'stream'; note: string }[];
  build: () => FrameSpec[];
}

const cases: CaseDef[] = [
  {
    caseId: 'baseline',
    title: '基线：合规 SETTINGS 交换 + CONTINUATION 链 + 双向独立动态表',
    mutates: null,
    expects: [],
    build: baseline,
  },
  {
    caseId: 'hpack-index-oob',
    title: '表索引越界：HEADERS 引用不存在的动态表索引 100',
    mutates: { frameOffsetOctets: 27, direction: 'c2s', replacementNote: '把 HEADERS block 改为单字节索引 0xe4=100（静态61+动态39，动态表为空）' },
    expects: [{ ruleId: 'R-HPACK-INDEX', scope: 'connection', note: 'COMPRESSION_ERROR 连接错误，证据指向 block 内 offset 0' }],
    build: () => {
      const b = baseline();
      b[4] = { note: b[4]!.note + '【改为索引 100 越界】', direction: 'c2s', bytes: headers(1, new Uint8Array([0xe4]), 0) };
      return b;
    },
  },
  {
    caseId: 'concurrent-header-block',
    title: '并发 header block：HEADERS 未 END_HEADERS 时插入 DATA',
    mutates: { frameOffsetOctets: 42, direction: 'c2s', replacementNote: '用 DATA stream1 替换原 CONTINUATION，打断 header block' },
    expects: [{ ruleId: 'R-HEADERBLOCK-CONTIGUITY', scope: 'connection', note: '连接错误，输入片段为插入的 DATA 帧' }],
    build: () => {
      const b = baseline();
      b[5] = { note: '非法插入：header block 未完时的 DATA stream1', direction: 'c2s', bytes: data(1, [1], false) };
      return b;
    },
  },
  {
    caseId: 'settings-ack-timing',
    title: 'SETTINGS ACK 时机：未发送 SETTINGS 先收到 ACK',
    mutates: { frameOffsetOctets: 9, direction: 's2c', replacementNote: '删除 s2c 非ACK SETTINGS，仅保留孤立 ACK' },
    expects: [{ ruleId: 'R-SETTINGS-ACK', scope: 'connection', note: 'unsolicited ACK 连接错误，且 c2s 256 上限未在该点生效' }],
    build: () => [
      { note: 'client SETTINGS 256 octet', direction: 'c2s', bytes: settings(false, 256) },
      { note: '孤立 ACK（s2c 未发过非 ACK SETTINGS）', direction: 's2c', bytes: settings(true) },
      { note: 'client ACK（无对应 SETTINGS，同样非法）', direction: 'c2s', bytes: settings(true) },
      ...baseline().slice(4),
    ],
  },
  {
    caseId: 'padding-overflow',
    title: 'padding 越界：HEADERS 声明 pad length 200 octets，载荷仅数 octet',
    mutates: { frameOffsetOctets: 27, direction: 'c2s', replacementNote: 'HEADERS 加 PADDED，pad length=200 超过载荷' },
    expects: [{ ruleId: 'R-PADDING', scope: 'connection', note: '连接错误，原字节保留，pad-length 字段坐标 [0,1)' }],
    build: () => {
      const b = baseline();
      b[4] = { note: b[4]!.note + '【pad length=200 越界】', direction: 'c2s', bytes: headers(1, indexedHeaderBlock([2]), FrameFlags.END_HEADERS, { padLength: 200 }) };
      b.splice(5, 1);
      return b;
    },
  },
  {
    caseId: 'stream-id-exhaust',
    title: 'stream id 穷尽与保留位：HEADERS 使用 0x7fffffff 后，再来 R 位置位帧',
    mutates: { frameOffsetOctets: 27, direction: 'c2s', replacementNote: 'HEADERS stream=2147483647（31-bit 最大），随后 R 位帧' },
    expects: [
      { ruleId: 'R-STREAM-EXHAUST', scope: 'connection', note: '最大 id 的新 HEADERS 触发 ENHANCE_YOUR_CALM 连接错误' },
    ],
    build: () => [
      baseline()[0]!, baseline()[1]!, baseline()[2]!, baseline()[3]!,
      { note: 'HEADERS stream 2147483647（本方向 id 穷尽）', direction: 'c2s', bytes: headers(0x7fffffff, indexedHeaderBlock([2, 61, 1]), FrameFlags.END_HEADERS) },
      { note: '随后 R 位置位的 WINDOW_UPDATE（手工构造，stream 字段=0x80000000）', direction: 'c2s', bytes: raw(FrameType.WINDOW_UPDATE, 0, 0x80000000, [0, 0, 0, 1]) },
    ],
  },
  {
    caseId: 'half-closed-direction',
    title: '半关闭帧与方向表混淆：half-closed(local) 后 client 再发 HEADERS；并把 s2c 动态索引当 c2s 用',
    mutates: { frameOffsetOctets: 43, direction: 's2c', replacementNote: '在 stream 关闭后追加 c2s HEADERS（复用已关闭 stream 1）' },
    expects: [
      { ruleId: 'R-STREAM-REUSE', scope: 'stream', note: 'closed 后再发 HEADERS = STREAM_CLOSED，stream 错误不升级为连接错误' },
      { ruleId: 'R-HPACK-DIRECTION', scope: 'connection', note: '附加材料：c2s 引用仅存在于 s2c 动态表的索引（在独立 capture branch2 中体现）' },
    ],
    build: () => [
      ...baseline(),
      { note: 'stream 1 已 closed 后 client 又发 HEADERS（半关闭/方向混淆 + id 复用）', direction: 'c2s', bytes: headers(1, indexedHeaderBlock([2]), FrameFlags.END_HEADERS) },
      { note: 'closed stream 上的 DATA 同样按 stream 错误裁决', direction: 'c2s', bytes: data(1, [1], true) },
    ],
  },
];

// 第二个分支专门材料：
//  (1) HPACK 表按方向隔离——同一索引在两个方向命中不同条目；
//  (2) SETTINGS 确认前后上限不混用——在 ACK 生效点前发送 size update 256，
//      保留“严格（COMPRESSION_ERROR 候选）/宽松（延迟采纳候选）”两个合法解释；
//  (3) header block 未完时插入帧按连接错误裁决。
function directionBranch(): FrameSpec[] {
  // c2s 插入 x-dir: client-only 到 c2s 动态表；s2c 插入不同值。
  const c2sBlock = concatBytes(indexedHeaderBlock([2, 61, 1]), literalIncremental(20, 'client-only'));
  const s2cBlock = concatBytes(indexedHeaderBlock([4]), literalIncremental(24, 'server-only'));
  return [
    { note: 'client SETTINGS：c2s HEADER_TABLE_SIZE=256 octet（尚未 ACK）', direction: 'c2s', bytes: settings(false, 256) },
    { note: 'server SETTINGS：空（s2c 保持 4096 octet）', direction: 's2c', bytes: settings(false) },
    { note: 'HEADERS stream 1：c2s block 以 size update 256 开头（ACK 前 → 双候选）+ 字面 client-only', direction: 'c2s', bytes: headers(1, concatBytes(new Uint8Array([0x3f, 0x21]), c2sBlock), FrameFlags.END_HEADERS) },
    { note: '此时 server 才 ACK（ACK 生效点晚于该 block），上限不回溯适用', direction: 's2c', bytes: settings(true) },
    { note: 'server HEADERS stream 1：s2c 独立动态表插入 server-only', direction: 's2c', bytes: headers(1, s2cBlock, FrameFlags.END_HEADERS) },
    { note: 'client HEADERS stream 3：引用动态表索引 62（应为 c2s 的 client-only，绝非 s2c 条目）', direction: 'c2s', bytes: headers(3, indexedHeaderBlock([62]), FrameFlags.END_HEADERS) },
  ];
}

const directionCase: CaseDef = {
  caseId: 'direction-and-ack-branch',
  title: '分支2：方向隔离 + SETTINGS ACK 前后上限多候选 + 连接/stream 错误分离',
  mutates: null,
  expects: [
    { ruleId: 'R-HPACK-DIRECTION', scope: 'connection', note: 'stream3 的索引 62 必须命中 c2s 动态表 client-only；若跨方向读到 server-only 即方向表混淆' },
    { ruleId: 'R-HPACK-SIZE-LIMIT', scope: 'connection', note: 'ACK 前 size update 256 产出两个候选（严格=COMPRESSION_ERROR / 宽松=延迟到 ACK 采纳），无法唯一决定时全部保留' },
  ],
  build: directionBranch,
};

// 案例包叙事修订记录（参数修订 / 局部源改动 / 互相冲突的人工决定）
const narrative = {
  domain: 'HTTP/2 (RFC 7540) + HPACK (RFC 7541)',
  units: {
    frameOffset: 'octet（按方向字节流）',
    tableSize: 'octet',
    streamId: '31-bit unsigned integer（R 位必须 0）',
    byteRange: '[startOctet,endOctet) half-open',
  },
  initialVersion: 'v1.0.0',
  revisions: [
    {
      revisionId: 'rev-params-v2',
      kind: 'parameter-revision',
      fromRulePack: 1,
      toRulePack: 2,
      note: '参数修订：R-HPACK-SIZE-LIMIT 升级到 v2，要求 ACK 前后候选全部显式保留。失效范围仅限引用该规则的 findings（hpack/settings 标签），帧时间线与 stream 状态不失效。',
      affectsTags: ['hpack', 'settings'],
    },
    {
      revisionId: 'rev-local-source',
      kind: 'local-source-change',
      note: '只影响局部依赖的源数据改动：替换 baseline 中偏移 27 的 c2s HEADERS 原帧字节（索引越界变体）。失效范围=该 RawFrame 的下游派生（header-block/headers/table-version/findings），其它帧结论保持。',
      replacesFrame: { frameId: 'f27_c2s', caseId: 'hpack-index-oob' },
    },
    {
      revisionId: 'rev-conflicting-decisions',
      kind: 'conflicting-human-decisions',
      note: '互相冲突的人工决定：对 ACK 前 size update 256，审阅者 A 采纳“严格 COMPRESSION_ERROR 连接错误”，审阅者 B 采纳“宽松延迟采纳”。两个分支都保留被采纳与未采纳结果，冲突在合并保存时暴露双方差异。',
      candidates: [
        { candidateId: 'limit-256-strict', decision: 'reject-block', adoptedBy: 'reviewer-A' },
        { candidateId: 'limit-256-lax', decision: 'adopt-after-ack', adoptedBy: 'reviewer-B' },
      ],
    },
  ],
  acceptancePath: ['frame-timeline', 'stream-state-machine', 'dynamic-table-evolution', 'header-origin', 'earliest-protocol-violation'],
};

const outDir = join(dirname(fileURLToPath(import.meta.url)));
const manifest = {
  packId: 'hpack-state-mirror-offline-pack',
  title: 'HPACK 状态镜离线案例包：HTTP/2 帧、动态表与流生命周期',
  ...narrative,
  generatedAt: '2026-09-24T00:00:00+09:00',
  cases: [] as unknown[],
};

for (const c of [...cases, directionCase]) {
  const specs = c.build();
  const frames = toRawFrames(specs);
  const doc = {
    caseId: c.caseId,
    title: c.title,
    mutates: c.mutates,
    expects: c.expects,
    coordinateSystem: { frameOffset: 'octet per direction', streamId: 'uint31', range: 'half-open [start,end)' },
    frames: specs.map((s, i) => ({ ...frames[i]!, note: s.note })),
  };
  writeFileSync(join(outDir, `${c.caseId}.json`), JSON.stringify(doc, null, 2) + '\n');
  (manifest.cases as unknown[]).push({ caseId: c.caseId, title: c.title, file: `${c.caseId}.json`, expects: c.expects, mutates: c.mutates });
  console.log('wrote', c.caseId, frames.length, 'frames');
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote manifest');
