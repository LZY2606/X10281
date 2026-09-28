import { hexToBytes as toBytes } from './binary.ts'
export { decodeInteger } from './binary.ts'
export function hexToBytes(hex: string): Uint8Array { return toBytes(hex) }
