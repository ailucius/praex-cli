<p align="center">
  <a href="https://praex.ai">
    <img src=".github/assets/praex-mark.png" width="96" alt="Praex" />
  </a>
</p>
<h1 align="center">Praex</h1>
<p align="center">The AI coding agent that answers the question.</p>
<p align="center">
  <a href="https://praex.ai">praex.ai</a> ·
  <a href="https://praex.ai/download">Download</a> ·
  <a href="https://praex.ai/chat">Chat in the browser</a>
</p>

<p align="center">
  <img src=".github/assets/praex-tui.png" width="760" alt="Praex in the terminal explaining a Python file" />
</p>

---

Praex is a terminal-first AI coding agent. It reads your codebase, edits files, runs commands, searches the web, and remembers you between sessions. Use it with Praex hosted models or bring your own key for any major provider.

## Install

```bash
curl -fsSL https://praex.ai/install.sh | bash
```

Then sign in and go:

```bash
praex login
praex
```

## Models

Praex ships with hosted models we post-train and serve on our own GPUs:

| Tier | Model | Plan |
|---|---|---|
| Velox | fast daily driver | Free |
| Faber | heavier coding and reasoning | Pro |
| Lucia | frontier-class flagship | Max |

**No nannying.** Praex models answer the question without moralizing, lecturing, or refusing legitimate work. There is a hard floor for genuinely dangerous content, and nothing else.

Prefer your own provider? BYOK works with OpenAI, Anthropic, Gemini, Groq, DeepSeek, Mistral, OpenRouter, xAI, Ollama, or any OpenAI-compatible endpoint. BYOK usage is unlimited and free.

## Highlights

- **TUI** built for real work: folded tool output, sessions, themes
- **/rc** · Remote Control: keep a session running here and continue it from your phone or the web
- **Web search** on hosted tiers, permission-gated per query
- **Memory** · persistent per-user memory across sessions
- **Permission modes** · manual approval by default, loosen when you trust it

## Build from source

Requires [Bun](https://bun.sh).

```bash
bun install
cd packages/opencode
bun run script/build.ts --single
./dist/opencode-linux-x64/bin/opencode --version
```

## Built on OpenCode

Praex is a fork of [OpenCode](https://github.com/anomalyco/opencode) (MIT). We keep its excellent agent core and take the product in our own direction: hosted Praex models, cloud sign-in, Remote Control (/rc), persistent memory, and the no-nannying assistant experience. Upstream attribution is preserved in [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

[MIT](LICENSE)
