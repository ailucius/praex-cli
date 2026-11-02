# praex

Praex is an open source (MIT) AI coding agent for the terminal. It reads your codebase, edits files, runs commands, and keeps sessions you can come back to. Use it with your own key for any major provider or with a model running on your own machine. No Praex account is needed for either.

## Install

```bash
npm install -g praex
praex
```

npm installs one prebuilt binary for your machine: Linux x64 and macOS (Apple Silicon and Intel). Node 18 or newer is needed only to start it.

Other ways to install:

```bash
brew install downoff/tap/praex
curl -fsSL https://praex.ai/install.sh | bash
```

## Update

```bash
npm install -g praex@latest
```

Installs from npm leave updates to npm, so the built in updater stays off. Set `PRAEX_DISABLE_AUTOUPDATE=0` to turn it back on.

## Use your own key

```bash
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ...
praex
```

Or store a key with `praex auth login`. `praex models` lists what is available.

## Links

* Website: https://praex.ai
* Source and releases: https://github.com/ailucius/praex-cli

## License

MIT. Praex is a fork of [OpenCode](https://github.com/anomalyco/opencode) and ships its MIT license; see `LICENSE` and `THIRD-PARTY-NOTICES.md` in this package.
