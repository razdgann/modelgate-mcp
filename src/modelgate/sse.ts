import { ModelGateMcpError } from "../errors/errors.js";

const MAX_EVENT_BYTES = 1_048_576;

/**
 * Parse a Server-Sent Events byte stream into `data:` payloads (one string per
 * event; multi-line data joined with "\n"). Comment/keepalive lines and other
 * fields are ignored. An event larger than 1 MiB is treated as a malformed
 * upstream rather than buffered without bound.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buf += value;
      if (buf.length > MAX_EVENT_BYTES) {
        throw new ModelGateMcpError("malformed_response", "ModelGate sent an oversized stream event.");
      }
      let sep: RegExpExecArray | null;
      const re = /\r?\n\r?\n/;
      while ((sep = re.exec(buf)) !== null) {
        const raw = buf.slice(0, sep.index);
        buf = buf.slice(sep.index + sep[0].length);
        const data = eventData(raw);
        if (data !== undefined) yield data;
      }
    }
    const tail = eventData(buf);
    if (tail !== undefined) yield tail;
  } finally {
    // Consumer stopped early (cancellation, error): close the upstream body.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function eventData(raw: string): string | undefined {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) lines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  return lines.length ? lines.join("\n") : undefined;
}
