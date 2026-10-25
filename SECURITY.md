# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

OpenCode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

OpenCode does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run OpenCode inside a Docker container or VM.

### Server Mode

Server mode is opt-in only. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

# Reporting Security Issues

Praex is built on [OpenCode](https://github.com/anomalyco/opencode) (MIT). Report issues to the project that owns
the code:

- **Praex** (this repository, the Praex gateway and hosted models, sign-in and billing, the desktop app and its
  downloads, Remote Control and the relay, or anything Praex changed): email davor@praex.ai (the contact in
  https://praex.ai/.well-known/security.txt). Please do not open a public issue.
- **Upstream OpenCode** (a problem that also exists in unmodified OpenCode): report it to OpenCode through their
  [security advisory form](https://github.com/anomalyco/opencode/security/advisories/new) as well, and tell us so we
  can ship their fix.

We acknowledge reports within 6 business days and keep you informed until a fix ships. Fixes go to the latest
release; please reproduce on it before reporting.
