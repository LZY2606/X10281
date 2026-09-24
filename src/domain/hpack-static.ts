/**
 * HPACK 静态表（RFC 7541 Appendix A，61 项，1 基索引）。
 */
export interface StaticEntry {
  name: string;
  value: string;
  neverIndexed?: boolean;
}

const RAW: [string, string][] = [
  [":authority", ""],
  [":method", "GET"],
  [":method", "POST"],
  [":path", "/"],
  [":path", "/index.html"],
  [":scheme", "http"],
  [":scheme", "https"],
  [":status", "200"],
  [":status", "204"],
  [":status", "206"],
  [":status", "304"],
  [":status", "400"],
  [":status", "404"],
  [":status", "500"],
  ["accept-charset", ""],
  ["accept-encoding", "gzip, deflate"],
  ["accept-language", ""],
  ["accept-ranges", ""],
  ["accept", ""],
  ["access-control-allow-origin", ""],
  ["age", ""],
  ["allow", ""],
  ["authorization", ""],
  ["cache-control", ""],
  ["content-disposition", ""],
  ["content-encoding", ""],
  ["content-language", ""],
  ["content-length", ""],
  ["content-location", ""],
  ["content-range", ""],
  ["content-type", ""],
  ["cookie", ""],
  ["date", ""],
  ["etag", ""],
  ["expect", ""],
  ["expires", ""],
  ["from", ""],
  ["host", ""],
  ["if-match", ""],
  ["if-modified-since", ""],
  ["if-none-match", ""],
  ["if-range", ""],
  ["if-unmodified-since", ""],
  ["last-modified", ""],
  ["link", ""],
  ["location", ""],
  ["max-forwards", ""],
  ["proxy-authenticate", ""],
  ["proxy-authorization", ""],
  ["range", ""],
  ["referer", ""],
  ["refresh", ""],
  ["retry-after", ""],
  ["server", ""],
  ["set-cookie", ""],
  ["strict-transport-security", ""],
  ["transfer-encoding", ""],
  ["user-agent", ""],
  ["vary", ""],
  ["via", ""],
  ["www-authenticate", ""],
];

export const STATIC_TABLE: StaticEntry[] = RAW.map(([name, value]) => ({ name, value }));
export const STATIC_TABLE_SIZE = STATIC_TABLE.length;

export function staticLookup(index1Based: number): StaticEntry | undefined {
  return STATIC_TABLE[index1Based - 1];
}

export function findStaticExact(name: string, value: string): number {
  for (let i = 0; i < STATIC_TABLE.length; i++) {
    const e = STATIC_TABLE[i];
    if (e.name === name && e.value === value) return i + 1;
  }
  return 0;
}
