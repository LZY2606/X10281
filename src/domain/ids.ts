/**
 * 稳定身份：全部使用同步、确定的 FNV-1a 64 位指纹（hex16）。
 * 不依赖数据库自增 rowid，因此导出→删库→再导入后身份不变。
 */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, "0");
}

export function stableId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${fnv1a64(parts.map((p) => String(p)).join(""))}`;
}
