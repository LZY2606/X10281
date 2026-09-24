/** HTTP/2 stream 状态机（RFC 7540 §5.1），从连接观察者视角按方向跟踪。 */
import type { Direction } from './frames.js';

export type StreamState =
  | 'idle'
  | 'open'
  | 'half-closed(c2s)'
  | 'half-closed(s2c)'
  | 'closed';

export interface StreamTransition {
  frameId: string;
  frameIndex: number;
  from: StreamState;
  to: StreamState;
  cause: string;
}

export interface StreamInfo {
  id: number;
  state: StreamState;
  transitions: StreamTransition[];
}

/** 发送方关闭侧：c2s 方向发的 END_STREAM 关闭 c2s 侧 */
function halfClosedFor(dir: Direction): StreamState {
  return dir === 'c2s' ? 'half-closed(c2s)' : 'half-closed(s2c)';
}

export interface TransitionResult {
  transition?: StreamTransition;
  /** 协议违约（stream 范围），由 replay 层归类 */
  violation?: { code: string; message: string };
}

/**
 * 应用一帧到 stream 状态。
 * kind: 'HEADERS' | 'DATA' | 'RST_STREAM' | 'CONTINUATION' | 'OTHER'
 */
export function applyFrame(
  info: StreamInfo,
  frameId: string,
  frameIndex: number,
  dir: Direction,
  kind: 'HEADERS' | 'DATA' | 'RST_STREAM' | 'CONTINUATION' | 'OTHER',
  endStream: boolean,
): TransitionResult {
  const t = (to: StreamState, cause: string): TransitionResult => {
    const transition: StreamTransition = { frameId, frameIndex, from: info.state, to, cause };
    info.state = to;
    info.transitions.push(transition);
    return { transition };
  };

  switch (info.state) {
    case 'idle':
      if (kind === 'HEADERS') {
        return endStream ? t(halfClosedFor(dir), 'HEADERS+END_STREAM on idle') : t('open', 'HEADERS on idle');
      }
      if (kind === 'OTHER') return {};
      return { violation: { code: 'PROTOCOL_ERROR', message: `${kind} on idle stream ${info.id}` } };
    case 'open': {
      if (kind === 'RST_STREAM') return t('closed', 'RST_STREAM');
      if (endStream && (kind === 'DATA' || kind === 'HEADERS')) {
        return t(halfClosedFor(dir), `END_STREAM from ${dir}`);
      }
      return {};
    }
    case 'half-closed(c2s)':
    case 'half-closed(s2c)': {
      const closedSide: Direction = info.state === 'half-closed(c2s)' ? 'c2s' : 's2c';
      if (kind === 'RST_STREAM') return t('closed', 'RST_STREAM');
      if (endStream && (kind === 'DATA' || kind === 'HEADERS') && dir !== closedSide) {
        return t('closed', `END_STREAM from ${dir} completes close`);
      }
      if (dir === closedSide && kind !== 'OTHER') {
        // 半关闭帧：已关闭侧再发帧 → stream 错误 STREAM_CLOSED（与连接错误分开）
        return {
          violation: {
            code: 'STREAM_CLOSED',
            message: `${kind} from ${dir} on ${info.state} stream ${info.id}`,
          },
        };
      }
      return {};
    }
    case 'closed':
      if (kind === 'OTHER') return {};
      return {
        violation: { code: 'STREAM_CLOSED', message: `${kind} on closed stream ${info.id}` },
      };
  }
}
