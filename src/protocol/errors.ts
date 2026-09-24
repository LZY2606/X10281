import type { ErrorCodeName, ErrorScope } from '../shared/types.js';

/** A protocol-level decode failure carrying an HTTP/2 error code and scope. */
export class ProtocolDecodeError extends Error {
  constructor(
    readonly code: ErrorCodeName,
    readonly scope: ErrorScope,
    readonly ruleId: string,
    readonly rfcCitation: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolDecodeError';
  }
}
