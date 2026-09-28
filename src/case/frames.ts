import { hexToBytes } from './hpack.ts'

export const FRAME_TYPES: Record<number, string> = {
  0: 'DATA',
  1: 'HEADERS',
  2: 'PRIORITY',
  3: 'RST_STREAM',
  4: 'SETTINGS',
  5: 'PUSH_PROMISE',
  6: 'PING',
  7: 'GOAWAY',
  8: 'WINDOW_UPDATE',
  9: 'CONTINUATION'
}

export function frame(type: number, flags: number, streamId: number, payloadHex = ''): string {
  const payload = hexToBytes(payloadHex)
  const header = new Uint8Array(9)
  const view = new DataView(header.buffer)
  view.setUint32(0, payload.length)
  header[4] = type
  header[5] = flags
  view.setUint32(6, streamId & 0x7fffffff)
  return [...header, ...payload].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function settingsAck(): string {
  return frame(4, 1, 0)
}

export function goaway(lastStream: number, errorCode: number, debug = ''): string {
  const payload = new Uint8Array(8 + hexToBytes(debug).length)
  const view = new DataView(payload.buffer)
  view.setUint32(0, lastStream & 0x7fffffff)
  view.setUint32(4, errorCode)
  payload.set(hexToBytes(debug), 8)
  return frame(7, 0, 0, [...payload].map((b) => b.toString(16).padStart(2, '0')).join(''))
}
