/**
 * HTTP/2 stream 状态机（RFC 9113 §5.1）。
 *
 * 采用标准五状态（idle / open / half-closed(local) / half-closed(remote) / closed），
 * local/remote 以“流的发起方”为锚：客户端发起的流，local=客户端。
 * 帧按连接方向（c2s/s2c）映射为“该流上的发送端”，再按 RFC 9113 图裁决。
 *
 * 协议违约的错误范围分级（RFC 9113 §5.4.2 / §5.4）：
 * - 连接错误：R 位、stream id 违反奇偶/穷尽复用、CONTINUATION 交错、
 *   padding 越界、SETTINGS/ACK 时序、HPACK 解压缩（COMPRESSION_ERROR）等；
 * - stream 错误：单流状态机上的非法帧（如对端 half-closed 后再发 HEADERS 等），
 *   影响必须限制在该 stream id。
 */

export type StreamState = "idle" | "open" | "half-local" | "half-remote" | "closed";

export interface StreamInitiator {
  id: number;
  /** 该 id 的合法发起端：奇数客户端，偶数（>0）服务端。 */
  initiator: "client" | "server";
}

export type Endpoint = "client" | "server";

export interface FrameSemantics {
  kind:
    | "HEADERS"
    | "DATA"
    | "END_STREAM"
    | "RST_STREAM"
    | "CONTINUATION"
    | "PRIORITY"
    | "PUSH_PROMISE"
    | "connection-level";
  sender: Endpoint;
  endStream: boolean;
}

export interface TransitionResult {
  from: StreamState;
  to: StreamState;
  legal: boolean;
  errorScope?: "connection" | "stream";
  errorCode?: string;
  rule: string;
}

export function initiatorForStreamId(id: number): Endpoint | null {
  if (id === 0) return null;
  return id % 2 === 1 ? "client" : "server";
}

export function senderOf(direction: "c2s" | "s2c"): Endpoint {
  return direction === "c2s" ? "client" : "server";
}

/**
 * 帧在流状态上的合法性。HEADERS/DATA/RST_STREAM 受状态约束；
 * WINDOW_UPDATE/PRIORITY/PING 等连接级帧不在此处裁决。
 */
export function applyFrame(state: StreamState, sem: FrameSemantics, streamId: number): TransitionResult {
  if (sem.kind === "connection-level") return legal(state, state, "RFC9113:connection-frame:no-stream-state");
  if (sem.kind === "PRIORITY") return legal(state, state, "RFC9113:5.3:priority-any-state-except-idle");
  if (sem.kind === "RST_STREAM") {
    if (state === "idle") {
      // RST_STREAM 不能出现在 idle 流（idle 流没有任何帧可寻址）。
      return illegal(state, "stream", "PROTOCOL_ERROR", "RFC9113:6.4:rst-on-idle");
    }
    return legal(state, "closed", "RFC9113:6.4:rst-moves-to-closed");
  }

  if (state === "idle") {
    if (sem.kind === "HEADERS") {
      const to = sem.endStream ? "half-remote" : "open";
      return legal("idle", to, "RFC9113:5.1:headers-open");
    }
    if (sem.kind === "PUSH_PROMISE") {
      return legal("idle", "half-remote", "RFC9113:8.2:push-reserved");
    }
    return illegal("idle", "stream", "PROTOCOL_ERROR", "RFC9113:5.1:frame-on-idle");
  }

  if (state === "open") {
    if (sem.kind === "HEADERS") {
      // open 流上再次出现 HEADERS（ trailers 合法，要求 END_STREAM）。
      if (sem.endStream) {
        const to: StreamState = semIsLocal(sem, streamId) ? "half-remote" : "half-local";
        return legal("open", to, "RFC9113:8.6:trailers-end-stream");
      }
      return illegal("open", "stream", "PROTOCOL_ERROR", "RFC9113:8.6:headers-without-end-stream-on-open");
    }
    if (sem.kind === "DATA") {
      if (sem.endStream) {
        const to: StreamState = semIsLocal(sem, streamId) ? "half-remote" : "half-local";
        return legal("open", to, "RFC9113:5.1:data-end-stream");
      }
      return legal("open", "open", "RFC9113:6.9.1:data-on-open");
    }
    if (sem.kind === "CONTINUATION") return legal("open", "open", "RFC9113:6.10:continuation-after-headers");
  }

  // 半关闭：发起方视角。half-local = 本端（发起方）已发 END_STREAM，只能收不能发数据/控制流帧。
  if (state === "half-local") {
    const local = semIsLocal(sem, streamId);
    if (sem.kind === "HEADERS" || sem.kind === "DATA") {
      if (local) {
        return illegal("half-local", "stream", "STREAM_CLOSED", "RFC9113:5.1:frame-after-sending-end-stream");
      }
      if (sem.endStream) return legal("half-local", "closed", "RFC9113:5.1:remote-end-stream-closes");
      return legal("half-local", "half-local", "RFC9113:5.1:receive-on-half-closed");
    }
    if (sem.kind === "CONTINUATION") return legal("half-local", "half-local", "RFC9113:6.10:continuation");
  }

  if (state === "half-remote") {
    const local = semIsLocal(sem, streamId);
    if (sem.kind === "HEADERS" || sem.kind === "DATA") {
      if (!local) {
        return illegal("half-remote", "stream", "STREAM_CLOSED", "RFC9113:5.1:frame-after-receiving-end-stream");
      }
      if (sem.endStream) return legal("half-remote", "closed", "RFC9113:5.1:local-end-stream-closes");
      return legal("half-remote", "half-remote", "RFC9113:5.1:send-on-half-closed");
    }
    if (sem.kind === "CONTINUATION") return legal("half-remote", "half-remote", "RFC9113:6.10:continuation");
  }

  if (state === "closed") {
    if (sem.kind === "HEADERS") {
      // closed 流上再发 HEADERS 是 stream 错误（可能触发自动重试判断，但本工具严格裁决）。
      return illegal("closed", "stream", "STREAM_CLOSED", "RFC9113:5.1:headers-on-closed");
    }
    if (sem.kind === "DATA") {
      return illegal("closed", "stream", "STREAM_CLOSED", "RFC9113:5.1:data-on-closed");
    }
    if (sem.kind === "CONTINUATION") {
      return illegal("closed", "connection", "PROTOCOL_ERROR", "RFC9113:6.10:continuation-on-closed-connection-error");
    }
  }

  return illegal(state, "stream", "PROTOCOL_ERROR", "RFC9113:5.1:unhandled-transition");
}

/** 该帧是否来自“流发起方本人（local）”。 */
function semIsLocal(sem: FrameSemantics, streamId: number): boolean {
  const initiator = initiatorForStreamId(streamId);
  return sem.sender === initiator;
}

function legal(from: StreamState, to: StreamState, rule: string): TransitionResult {
  return { from, to, legal: true, rule };
}

function illegal(
  from: StreamState,
  errorScope: "connection" | "stream",
  errorCode: string,
  rule: string,
): TransitionResult {
  return { from, to: from, legal: false, errorScope, errorCode, rule };
}
