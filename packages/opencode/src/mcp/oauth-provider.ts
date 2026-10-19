import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Effect } from "effect"
import { McpAuth } from "./auth"

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

/**
 * The MCP server now names a different authorization server than the one its stored
 * credentials were issued by. The credentials have already been dropped, unsent; the
 * user has to sign in again. The message keeps the word "OAuth" so the connect path
 * reports the server as needing sign-in.
 */
export class McpOAuthAuthServerChangedError extends Error {
  constructor(
    readonly mcpName: string,
    readonly previous: McpAuth.AuthServer,
    readonly current: McpAuth.AuthServer,
  ) {
    super(
      `MCP ${mcpName}: OAuth authorization server changed from ${previous.issuer} to ${current.issuer}. ` +
        `Stored credentials were removed without being sent; sign in again with: praex mcp auth ${mcpName}`,
    )
    this.name = "McpOAuthAuthServerChangedError"
  }
}

// How the stored credentials relate to the authorization server discovered in this flow:
// "unverified" = no discovery has happened yet (only the MCP server itself is being talked
//                to, e.g. the transport attaching the access token), so no secret is handed out;
// "bound"      = the stored credentials were issued by the discovered server;
// "fresh"      = nothing usable is stored, a new registration/sign-in binds to this server.
type Binding = "unverified" | "bound" | "fresh"

export class McpOAuthProvider implements OAuthClientProvider {
  // Authorization server found by the SDK's discovery in the current auth() call. The SDK
  // calls saveDiscoveryState() after discovery and before it reads clientInformation() or
  // tokens(), so the binding check below always runs before anything goes to that server.
  // Do NOT implement discoveryState(): the SDK's cached-discovery branch skips
  // saveDiscoveryState(), which would leave the check without a current server.
  private discovered: McpAuth.AuthServer | undefined

  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private auth: McpAuth.Interface,
  ) {}

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const url = String(state.authorizationServerUrl)
    this.discovered = { issuer: state.authorizationServerMetadata?.issuer ?? url, url }
  }

  private async binding(): Promise<Binding> {
    const current = this.discovered
    if (!current) return "unverified"
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    const previous = entry?.authServer
    if (previous) {
      if (previous.issuer === current.issuer && previous.url === current.url) return "bound"
      await Effect.runPromise(this.auth.dropCredentials(this.mcpName))
      throw new McpOAuthAuthServerChangedError(this.mcpName, previous, current)
    }
    // Legacy credentials saved before the binding existed: the server they were issued by is
    // unknown, so they are not trusted with any authorization server (binding them to whatever
    // the MCP server names today is exactly the redirect this check exists for). Drop them; the
    // flow continues as a fresh sign-in and the new credentials are bound. The legacy access
    // token is still attached to MCP requests until it stops working, so the cost is one re-sign-in.
    if (entry?.tokens || entry?.clientInfo) await Effect.runPromise(this.auth.dropCredentials(this.mcpName))
    return "fresh"
  }

  private async bind(): Promise<void> {
    if (!this.discovered) return
    await Effect.runPromise(this.auth.updateAuthServer(this.mcpName, this.discovered, this.serverUrl))
  }

  get redirectUrl(): string {
    if (this.config.redirectUri) {
      return this.config.redirectUri
    }
    const port = this.config.callbackPort ?? OAUTH_CALLBACK_PORT
    return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Praex",
      client_uri: "https://praex.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const binding = await this.binding()

    // Check config first (pre-registered client). Its secret only goes out once the flow
    // has discovered an authorization server that passed the binding check.
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: binding === "unverified" ? undefined : this.config.clientSecret,
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: binding === "bound" ? entry.clientInfo.clientSecret : undefined,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.bind()
    await Effect.runPromise(
      this.auth.updateClientInfo(
        this.mcpName,
        {
          clientId: info.client_id,
          clientSecret: info.client_secret,
          clientIdIssuedAt: info.client_id_issued_at,
          clientSecretExpiresAt: info.client_secret_expires_at,
        },
        this.serverUrl,
      ),
    )
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const binding = await this.binding()
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    if (!entry?.tokens) return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      // The refresh token is only handed to the SDK for a refresh at the bound server.
      refresh_token: binding === "bound" ? entry.tokens.refreshToken : undefined,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.bind()
    await Effect.runPromise(
      this.auth.updateTokens(
        this.mcpName,
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
          scope: tokens.scope,
        },
        this.serverUrl,
      ),
    )
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await Effect.runPromise(this.auth.updateCodeVerifier(this.mcpName, codeVerifier))
  }

  async codeVerifier(): Promise<string> {
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    await Effect.runPromise(this.auth.updateOAuthState(this.mcpName, state))
  }

  async state(): Promise<string> {
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    if (entry?.oauthState) {
      return entry.oauthState
    }

    // Generate a new state if none exists — the SDK calls state() as a
    // generator, not just a reader, so we need to produce a value even when
    // startAuth() hasn't pre-saved one (e.g. during automatic auth on first
    // connect).
    const newState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await Effect.runPromise(this.auth.updateOAuthState(this.mcpName, newState))
    return newState
  }

  async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    if (!entry) {
      return
    }

    switch (type) {
      case "all":
        await Effect.runPromise(this.auth.remove(this.mcpName))
        break
      case "client":
        delete entry.clientInfo
        await Effect.runPromise(this.auth.set(this.mcpName, entry))
        break
      case "tokens":
        delete entry.tokens
        await Effect.runPromise(this.auth.set(this.mcpName, entry))
        break
    }
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }

/**
 * Parse a redirect URI to extract port and path for the callback server.
 * Returns defaults if the URI can't be parsed.
 */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }

  try {
    const url = new URL(redirectUri)
    const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
    const path = url.pathname || OAUTH_CALLBACK_PATH
    return { port, path }
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
}
