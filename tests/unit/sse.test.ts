import { describe, expect, it } from "vitest";
import { parseSse } from "../../src/modelgate/sse.js";

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function collect(parts: string[]) {
  const out: string[] = [];
  for await (const d of parseSse(streamOf(parts))) out.push(d);
  return out;
}

describe("parseSse", () => {
  it("parses events split across chunks and CRLF", async () => {
    expect(await collect(['data: {"a"', ":1}\n\n", "data: [DONE]\r\n\r\n"])).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("ignores comments and non-data fields, joins multi-line data", async () => {
    expect(await collect([": keepalive\n\n", "event: x\nid: 1\ndata: a\ndata: b\n\n"])).toEqual(["a\nb"]);
  });

  it("flushes a trailing event without a blank line", async () => {
    expect(await collect(["data: tail"])).toEqual(["tail"]);
  });

  it("rejects an oversized event", async () => {
    await expect(collect(["data: " + "x".repeat(1_100_000)])).rejects.toMatchObject({
      code: "malformed_response",
    });
  });
});
