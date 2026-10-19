import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { createRemoteControl, type RemoteStatus } from "@/remote"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

Heap.start()

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined
let remote: ReturnType<typeof createRemoteControl> | undefined

// Remote Control requests are served in-process, exactly like the TUI's own requests: no
// TCP listener is opened for them. If the user armed a server password, it applies here too.
async function dispatchInProcess(request: Request) {
  const auth = ServerAuth.header()
  if (auth && !request.headers.has("authorization")) request.headers.set("authorization", auth)
  return Server.Default().app.fetch(request)
}

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[]; password?: string }) {
    if (server) await server.stop(true)
    // listeners read auth from env via a fresh ConfigProvider per listen, so
    // setting it here arms Basic auth for the TCP listener without touching
    // the in-process transport (Flag/default config snapshot at module load)
    if (input.password) process.env.OPENCODE_SERVER_PASSWORD = input.password
    server = await Server.listen({ port: input.port, hostname: input.hostname, mdns: input.mdns, cors: input.cors })
    return { url: server.url.toString() }
  },
  async serverStop() {
    if (server) await server.stop(true)
    server = undefined
  },
  async remoteStart(input: { directory: string }) {
    remote ??= createRemoteControl({
      directory: input.directory,
      version: InstallationVersion,
      dispatch: dispatchInProcess,
      onStatus: (status: RemoteStatus) => Rpc.emit("remote.status", status),
    })
    return remote.start()
  },
  async remoteStop() {
    remote?.stop()
  },
  async remoteTitle(input: { title?: string }) {
    remote?.setTitle(input.title)
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    remote?.stop()
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)
