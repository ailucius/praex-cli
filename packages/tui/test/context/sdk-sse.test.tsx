/** @jsxImportSource @opentui/solid */
// 10-27 (audit9 R9-11): the SSE loop (`praex attach`, --port/--hostname) must survive a handler
// that throws. Before the fix the throw escaped the for-await, the loop's .catch(() => {})
// swallowed it and the TUI stopped receiving events for good.
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { directory } from "../fixture/tui-sdk"

function sse(events: unknown[], signal: AbortSignal | null | undefined) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`))
      // Stay open like a live server until the client aborts.
      signal?.addEventListener("abort", () => controller.close(), { once: true })
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

function event(type: string) {
  return { directory, payload: { id: `evt_${type}`, type, properties: {} } }
}

test("SSE event loop keeps delivering events after a handler throws", async () => {
  const seen: string[] = []
  let served = 0
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname !== "/global/event") return new Response("{}", { headers: { "content-type": "application/json" } })
    served += 1
    return sse(served === 1 ? [event("test.boom"), event("test.after")] : [], request.signal)
  }) as typeof globalThis.fetch

  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }

  function Probe() {
    const sdk = useSDK()
    sdk.event.on("event", (item) => {
      const type = item.payload.type as string
      seen.push(type)
      if (type === "test.boom") throw new Error("boom handler")
    })
    return <box />
  }

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory={directory} fetch={fetch}>
      <Probe />
    </SDKProvider>
  ))
  try {
    const start = Date.now()
    while (!seen.includes("test.after") && Date.now() - start < 2000) await Bun.sleep(10)
    expect(seen).toEqual(["test.boom", "test.after"])
    expect(errors.some((args) => args.some((arg) => String(arg).includes("boom handler")))).toBe(true)
  } finally {
    console.error = original
    app.renderer.destroy()
  }
})
