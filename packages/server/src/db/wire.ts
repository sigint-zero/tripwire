// Framing for the PostgreSQL wire protocol, as far as the pooler needs it:
// splitting what clients send into whole messages, and finding the
// transaction status the database reports after each exchange.

/** The request codes a client can open a connection with. */
export const PROTOCOL_3 = 196_608;
export const SSL_REQUEST = 80_877_103;
export const GSSENC_REQUEST = 80_877_104;
export const CANCEL_REQUEST = 80_877_102;

/** Transaction status carried by ReadyForQuery: idle, in a transaction, or in a failed one. */
export type TransactionStatus = "I" | "T" | "E";

export type ClientFrame =
  | { kind: "startup"; bytes: Uint8Array }
  | { kind: "ssl" | "gssenc" | "cancel"; bytes: Uint8Array }
  | { kind: "message"; type: string; bytes: Uint8Array };

/**
 * Takes whole frames off the front of `buffer`. The first frame of a
 * connection has no type byte, so `started` says which form to expect.
 * Returns the frames and whatever is left over, an incomplete frame.
 */
export function splitFrames(
  buffer: Buffer,
  started: boolean,
): { frames: ClientFrame[]; rest: Buffer; started: boolean } {
  const frames: ClientFrame[] = [];
  let offset = 0;
  while (true) {
    if (!started) {
      if (buffer.length - offset < 8) break;
      const length = buffer.readInt32BE(offset);
      if (length < 8 || buffer.length - offset < length) break;
      const code = buffer.readInt32BE(offset + 4);
      const bytes = buffer.subarray(offset, offset + length);
      offset += length;
      if (code === SSL_REQUEST) frames.push({ kind: "ssl", bytes });
      else if (code === GSSENC_REQUEST) frames.push({ kind: "gssenc", bytes });
      else if (code === CANCEL_REQUEST) frames.push({ kind: "cancel", bytes });
      else {
        frames.push({ kind: "startup", bytes });
        started = true;
      }
      continue;
    }
    if (buffer.length - offset < 5) break;
    const length = buffer.readInt32BE(offset + 1);
    if (length < 4 || buffer.length - offset < length + 1) break;
    frames.push({
      kind: "message",
      type: String.fromCharCode(buffer[offset]!),
      bytes: buffer.subarray(offset, offset + length + 1),
    });
    offset += length + 1;
  }
  return { frames, rest: buffer.subarray(offset), started };
}

/** The status of the last ReadyForQuery in a server response, if it has one. */
export function lastReadyStatus(
  response: Uint8Array,
): TransactionStatus | null {
  let status: TransactionStatus | null = null;
  let offset = 0;
  while (offset + 5 <= response.length) {
    const type = response[offset]!;
    const length =
      ((response[offset + 1]! << 24) |
        (response[offset + 2]! << 16) |
        (response[offset + 3]! << 8) |
        response[offset + 4]!) >>>
      0;
    if (type === 0x5a && length === 5 && offset + 5 < response.length) {
      status = String.fromCharCode(response[offset + 5]!) as TransactionStatus;
    }
    offset += 1 + length;
  }
  return status;
}

/** A simple-query message carrying `sql`. */
export function queryMessage(sql: string): Uint8Array {
  const text = Buffer.from(`${sql}\0`, "utf8");
  const message = Buffer.alloc(5 + text.length);
  message.write("Q", 0, "latin1");
  message.writeInt32BE(4 + text.length, 1);
  text.copy(message, 5);
  return message;
}

/** A Sync message, which closes an extended-query sequence. */
export const SYNC = Uint8Array.from([0x53, 0, 0, 0, 4]);
