/**
 * 领域量：所有数值都携带单位或坐标基准。
 * 导入层保留原始表示（raw），派生层才做规范化；
 * 无法转换的值留在原位置并附诊断，绝不为了画图丢弃。
 */

export type Unit = 'octets' | 'ms' | 'frames' | 'entries' | 'dimensionless' | string;

export interface Quantity {
  /** 规范化后的数值；无法转换时保持原始值 */
  value: number | string;
  unit: Unit;
  /** 坐标基准，例如 'connection-start'、'c2s-byte-stream' */
  basis?: string;
  /** 导入时的原始表示，永远保留 */
  raw?: unknown;
}

export interface Diagnostic {
  code: 'UNIT_UNCONVERTIBLE' | 'UNIT_MISSING' | 'VALUE_UNPARSEABLE';
  message: string;
  /** 出问题的原始值，留在原位置 */
  raw: unknown;
}

const CONVERSIONS: Record<string, Record<string, (v: number) => number>> = {
  octets: { octets: (v) => v },
  ms: { ms: (v) => v, s: (v) => v / 1000 },
  s: { s: (v) => v, ms: (v) => v * 1000 },
  frames: { frames: (v) => v },
  entries: { entries: (v) => v },
  dimensionless: { dimensionless: (v) => v },
};

/** 派生层规范化：尝试把 quantity 转到 targetUnit。失败时原样保留并返回诊断。 */
export function normalize(
  q: Quantity,
  targetUnit: Unit,
): { quantity: Quantity; diagnostic?: Diagnostic } {
  if (q.unit === undefined || q.unit === null || q.unit === '') {
    return {
      quantity: q,
      diagnostic: { code: 'UNIT_MISSING', message: 'quantity has no unit; left in place', raw: q.raw ?? q },
    };
  }
  if (typeof q.value !== 'number') {
    const n = typeof q.value === 'string' ? Number(q.value) : NaN;
    if (Number.isFinite(n)) {
      return normalize({ ...q, value: n }, targetUnit);
    }
    return {
      quantity: q,
      diagnostic: {
        code: 'VALUE_UNPARSEABLE',
        message: `value ${JSON.stringify(q.value)} is not numeric; left in place`,
        raw: q.raw ?? q.value,
      },
    };
  }
  const conv = CONVERSIONS[q.unit]?.[targetUnit];
  if (!conv) {
    return {
      quantity: q,
      diagnostic: {
        code: 'UNIT_UNCONVERTIBLE',
        message: `cannot convert ${q.unit} -> ${targetUnit}; left in place`,
        raw: q.raw ?? q,
      },
    };
  }
  return { quantity: { ...q, value: conv(q.value), unit: targetUnit } };
}

/** 收集一组命名量的规范化结果与诊断（诊断不阻断流程）。 */
export function normalizeAll(
  qs: Record<string, Quantity>,
  targets: Record<string, Unit>,
): { values: Record<string, Quantity>; diagnostics: Diagnostic[] } {
  const values: Record<string, Quantity> = {};
  const diagnostics: Diagnostic[] = [];
  for (const [key, q] of Object.entries(qs)) {
    const target = targets[key] ?? q.unit;
    const r = normalize(q, target);
    values[key] = r.quantity;
    if (r.diagnostic) diagnostics.push(r.diagnostic);
  }
  return { values, diagnostics };
}
