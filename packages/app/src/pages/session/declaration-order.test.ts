import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import path from "path"
import ts from "typescript"

// createMemo, createRenderEffect and friends run their callback while the component body is
// still being set up. A const or let the callback reads that is declared further down is still
// uninitialised then, and throws "Cannot access ... before initialization". That crashed every
// chat with two or more turns when a memo read getMsgParts before its declaration.
const EAGER = new Set(["createMemo", "createRenderEffect", "createComputed", "createSelector", "mapArray", "indexArray", "untrack", "batch", "createRoot"])

function readsBeforeDeclaration(fileName: string, text: string) {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve }
  const host = ts.createCompilerHost(options)
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  host.getSourceFile = (name) => (name === fileName ? source : undefined)
  const checker = ts.createProgram([fileName], options, host).getTypeChecker()
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const found: string[] = []

  const scope = (fn: ts.Node) => {
    if (!ts.isFunctionLike(fn)) return
    const body = (fn as ts.FunctionLikeDeclaration).body
    if (!body || !ts.isBlock(body)) return
    // the statement of this function body a declaration belongs to, or -1 when it is in a nested function
    const owner = (decl: ts.Node) => {
      let node: ts.Node | undefined = decl
      while (node && node.parent !== body) {
        node = node.parent
        if (node && ts.isFunctionLike(node)) return -1
      }
      return node ? body.statements.indexOf(node as ts.Statement) : -1
    }
    body.statements.forEach((statement, index) => {
      if (ts.isFunctionLike(statement)) return
      const walk = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) {
          // only callbacks handed to a primitive that calls them right away run during setup
          const call = node.parent
          const runsNow =
            ts.isCallExpression(call) &&
            ts.isIdentifier(call.expression) &&
            EAGER.has(call.expression.text) &&
            call.arguments.some((arg) => arg === node)
          if (!runsNow) return
        }
        if (ts.isIdentifier(node)) {
          const decl = checker.getSymbolAtLocation(node)?.valueDeclaration
          if (
            decl &&
            ts.isVariableDeclaration(decl) &&
            ts.isVariableDeclarationList(decl.parent) &&
            decl.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let) &&
            owner(decl) >= index &&
            decl.getStart(source) > node.getStart(source)
          )
            found.push(`${path.basename(fileName)}:${line(node)} reads ${node.text}, declared at line ${line(decl)}`)
        }
        ts.forEachChild(node, walk)
      }
      walk(statement)
    })
  }
  const visit = (node: ts.Node) => {
    scope(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("session page declaration order", () => {
  test("the check catches a memo that reads a later declaration", () => {
    const text = `
      function Timeline() {
        const early = () => 1
        const grouped = createMemo(() => early() + parts("a"))
        const fine = createMemo(() => early())
        createEffect(() => parts("b"))
        const parts = (id: string) => id.length
        return grouped() + fine()
      }`
    expect(readsBeforeDeclaration("fixture.tsx", text)).toEqual(["fixture.tsx:4 reads parts, declared at line 7"])
  })

  const dir = import.meta.dir
  const files = [
    path.join(dir, "..", "session.tsx"),
    ...readdirSync(dir)
      .filter((name) => name.endsWith(".tsx") && !name.includes(".test.") && !name.includes(".stories."))
      .map((name) => path.join(dir, name)),
  ]

  test.each(files.map((file) => [path.relative(path.join(dir, ".."), file), file]))(
    "%s reads no const before its declaration during setup",
    (_, file) => {
      expect(readsBeforeDeclaration(file, readFileSync(file, "utf8"))).toEqual([])
    },
  )
})
