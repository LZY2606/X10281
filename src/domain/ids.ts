/**
 * 稳定身份：显示 slug（人类可读、分支内确定）+ uuid（全局稳定）。
 * 导出→删库→导入后两者都保持不变。
 */
import { randomUUID as nodeRandomUuid } from 'node:crypto';

export type Slug = string;

export function frameSlug(seq: number): Slug {
  return `frm-${String(seq).padStart(4, '0')}`;
}
export function blockSlug(streamId: number, idx: number): Slug {
  return `blk-s${streamId}-${String(idx).padStart(4, '0')}`;
}
export function tableVersionSlug(direction: string, version: number): Slug {
  return `tbl-${direction.toLowerCase()}@v${version}`;
}
export function streamSlug(streamId: number): Slug {
  return `stm-${streamId}`;
}
export function violationSlug(n: number): Slug {
  return `vio-${String(n).padStart(4, '0')}`;
}
export function candidateSlug(n: number): Slug {
  return `cand-${String(n).padStart(4, '0')}`;
}
export function decisionSlug(n: number): Slug {
  return `dec-${String(n).padStart(4, '0')}`;
}
export function eventSlug(n: number): Slug {
  return `evt-${String(n).padStart(4, '0')}`;
}
export function batchSlug(sourceKey: string, version: number): Slug {
  return `src-${sourceKey}@v${version}`;
}
export function branchSlug(key: string): Slug {
  return `br-${key}`;
}

export function uuid(): string {
  const g: any = globalThis;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return nodeRandomUuid();
}
