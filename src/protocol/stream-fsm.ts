import type { Direction, ParsedFrame, StreamState } from "./types.ts";

export interface FsmVerdict {
  legal: boolean;
  nextState?: StreamState;
  scope?: "connection" | "stream";
  code?: string;
  ruleId: string;
  section: string;
}

const RULE = {
  section: "RFC9113 §5.1 / §6",
} as const;

/**
 * 按 RFC 9113 §5.1 状态机裁决一帧对某 stream 是否合法。
 * perspective 指帧的发送方视角：half-closed-local 是“本端发了 END_STREAM”。
 * 这里 direction=c2s 时 local=客户端，s2c 时 local=服务端。
 */
export function judgeFrame(params: {
  state: StreamState;
  frame: ParsedFrame;
  ruleVersion: string;
}): FsmVerdict {
  const { state, frame, ruleVersion } = params;
  const isFromClient = frame.direction === "c2s";
  const role: "client" | "server" = isFromClient ? "client" : "server";

  // R 位规则随规则版本不同：RFC 7540 §5.1.1 要求忽略；RFC 9113 §5.1.1 是连接错误。
  if (frame.reservedBit === 1) {
    if (ruleVersion === "RFC7540") {
      return { legal: true, ruleId: "r-bit-ignored-7540", section: "RFC7540 §5.1.1" };
    }
    return {
      legal: false,
      scope: "connection",
      code: "PROTOCOL_ERROR",
      ruleId: "reserved-bit-must-be-zero",
      section: "RFC9113 §5.1.1",
    };
  }

  switch (frame.type) {
    case "PRIORITY":
      // PRIORITY 可在 idle（含）等状态上收到；closed 后被忽略；非 stream 0。
      if (frame.streamId === 0) {
        return connError("PRIORITY-on-stream-zero", "PRIORITY 帧的 stream id 不得为 0");
      }
      if (state === "closed") return { legal: true, ruleId: "priority-ignored-closed", section: RULE.section };
      return { legal: true, ruleId: "priority-any-nonidle-except", section: RULE.section };

    case "WINDOW_UPDATE":
    case "RST_STREAM":
      // 对不存在的 stream（idle）发送 WINDOW_UPDATE/RST_STREAM 是连接错误。
      if (state === "idle") {
        return connError("frame-on-idle-stream", `${frame.type} 不允许出现在 idle stream`);
      }
      if (frame.type === "RST_STREAM") {
        return { legal: true, nextState: "closed", ruleId: "rst-closes-stream", section: "RFC9113 §6.4" };
      }
      return { legal: true, ruleId: "window-update-ok", section: "RFC9113 §6.9" };

    case "HEADERS": {
      if (frame.streamId === 0) return connError("headers-on-stream-zero", "HEADERS 不得使用 stream 0");
      if (state === "idle") {
        const next: StreamState = frame.flags & 0x1
          ? role === "client"
            ? "half-closed-local"
            : "half-closed-remote"
          : "open";
        return { legal: true, nextState: next, ruleId: "headers-idle-transition", section: "RFC9113 §6.2" };
      }
      if (state === "open" || state === "half-closed-remote" || state === "half-closed-local") {
        // RFC 9113：open 或 half-closed (remote) 上的 HEADERS/_CONTINUATION 是“交错的 HTTP 字段”，允许。
        if (state === "half-closed-local") {
          // 本端已 END_STREAM 后再发 HEADERS：trailer 合法（HEADERS 可在 half-closed(local) 发送）。
          return { legal: true, ruleId: "trailers-in-half-closed-local", section: "RFC9113 §5.1" };
        }
        const es = (frame.flags & 0x1) !== 0;
        const next: StreamState = es ? "closed" : state === "open" ? "open" : state;
        return { legal: true, nextState: es ? "closed" : next, ruleId: "headers-open-or-halfremote", section: "RFC9113 §5.1" };
      }
      if (state === "closed") {
        // closed 上收到 HEADERS：stream 错误（接收方尚未重开；非 trailer 情形）。
        return streamError("stream-closed-headers", "closed stream 上收到 HEADERS");
      }
      return streamError("reserved-stream-headers", "reserved stream 上不能直接出现 HEADERS");
    }

    case "CONTINUATION":
      if (frame.streamId === 0) return connError("continuation-on-stream-zero", "CONTINUATION 不得使用 stream 0");
      if (state === "idle") return connError("continuation-without-headers", "CONTINUATION 之前没有 HEADERS（stream 仍 idle）");
      if (state === "closed") return streamError("stream-closed-continuation", "closed stream 上收到 CONTINUATION");
      return { legal: true, ruleId: "continuation-while-open", section: "RFC9113 §6.10" };

    case "DATA": {
      if (frame.streamId === 0) return connError("data-on-stream-zero", "DATA 不得使用 stream 0");
      if (state === "idle") return connError("data-on-idle-stream", "DATA 出现在 idle stream 上");
      if (state === "half-closed-local") {
        // 半关闭状态必须按“发送方向”解释：half-closed(local) 指本方向发送者已 END_STREAM。
        return streamError("data-after-end-stream-sender", "发送方 END_STREAM 后同方向再发 DATA（方向-半关闭混淆）");
      }
      if (state === "half-closed-remote") {
        // 对端已 END_STREAM 却继续发 DATA：stream 错误 STREAM_CLOSED。
        return streamError("data-after-end-stream-remote", "half-closed(remote) 后又收到 DATA");
      }
      if (state === "closed") return streamError("data-on-closed-stream", "closed stream 上收到 DATA");
      if (state.startsWith("reserved")) return streamError("data-on-reserved-stream", "reserved stream 上收到 DATA");
      const es = (frame.flags & 0x1) !== 0;
      return {
        legal: true,
        nextState: es
          ? state === "open"
            ? role === "client"
              ? "half-closed-local"
              : "half-closed-remote"
            : "closed"
          : state,
        ruleId: "data-open-transition",
        section: "RFC9113 §6.1",
      };
    }

    case "PUSH_PROMISE": {
      // 服务端推送：只能由 s2c 在由客户端发起的 stream 上发送。
      if (isFromClient) return connError("push-from-client", "客户端不能发送 PUSH_PROMISE");
      if (state === "idle" || state === "closed") {
        return connError("push-on-wrong-stream", "PUSH_PROMISE 只能出现在由对端发起且非 idle/closed 的 stream");
      }
      return { legal: true, ruleId: "push-promise-ok", section: "RFC9113 §8.2" };
    }

    case "GOAWAY":
      if (frame.streamId !== 0) return connError("goaway-nonzero-stream", "GOAWAY 必须关联 stream 0");
      return { legal: true, ruleId: "goaway-ok", section: "RFC9113 §6.8" };

    case "SETTINGS":
      if (frame.streamId !== 0) return connError("settings-nonzero-stream", "SETTINGS 必须关联 stream 0");
      if (frame.ack && frame.length !== 0) return connError("settings-ack-with-payload", "SETTINGS ACK 不得携带 payload");
      if (!frame.ack && frame.length % 6 !== 0) return connError("settings-bad-length", "SETTINGS payload 长度非法");
      return { legal: true, ruleId: "settings-ok", section: "RFC9113 §6.5" };

    case "PING":
      if (frame.streamId !== 0) return connError("ping-nonzero-stream", "PING 必须关联 stream 0");
      if (frame.length !== 8) return connError("ping-bad-length", "PING 必须为 8 字节");
      return { legal: true, ruleId: "ping-ok", section: "RFC9113 §6.7" };

    case "UNKNOWN":
      return { legal: true, ruleId: "unknown-frame-ignored", section: "RFC9113 §5.5" };
  }
}

function connError(ruleId: string, message: string): FsmVerdict {
  return { legal: false, scope: "connection", code: "PROTOCOL_ERROR", ruleId, section: "RFC9113" };
}

function streamError(ruleId: string, message: string): FsmVerdict {
  return { legal: false, scope: "stream", code: "STREAM_CLOSED", ruleId, section: "RFC9113 §5.1" };
}

/** 从发送方向推导 idle->reserved 的状态（PUSH_PROMISE 场景）。 */
export function reservedStateFor(direction: Direction): StreamState {
  return direction === "s2c" ? "reserved-remote" : "reserved-local";
}
