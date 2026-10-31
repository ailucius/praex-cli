// Test preload: compile Solid JSX for the DOM before Bun loads .tsx/.jsx files. Bun's own JSX transform emits a
// React-style runtime (jsxDEV) that solid-js does not export, so without this every test that imports a component
// fails to load. The app's tests preload this file too.
// @ts-expect-error no types
import { transformAsync } from "@babel/core"
// @ts-expect-error no types
import ts from "@babel/preset-typescript"
// @ts-expect-error no types
import solid from "babel-preset-solid"
import { plugin } from "bun"

plugin({
  name: "solid-dom",
  setup(build) {
    // Bun resolves solid-js to its server build; the tests run in a DOM, so load the browser build instead
    build.onLoad({ filter: /[/\\]solid-js[/\\](?:(web|store)[/\\])?dist[/\\]server\.js$/ }, async (args) => {
      const name = args.path.match(/[/\\]solid-js[/\\](web|store)[/\\]dist[/\\]/)?.[1] ?? "solid"
      return { contents: await Bun.file(args.path.replace(/server\.js$/, `${name}.js`)).text(), loader: "js" }
    })
    build.onLoad({ filter: /\.[jt]sx$/ }, async (args) => {
      const out = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [[solid, { generate: "dom" }], [ts]],
      })
      return { contents: out?.code ?? "", loader: "js" }
    })
  },
})
