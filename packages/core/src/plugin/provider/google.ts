import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/effect/integration"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { PluginInternal } from "../internal.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"

/**
 * Google Gemini (Generative Language API) Android AAS auth.
 *
 * The Gemini Developer API accepts OAuth access tokens only as
 * `Authorization: Bearer <token>`; an OAuth token sent as `x-goog-api-key` is
 * rejected with `API_KEY_INVALID`. The credential stores the Android auth
 * service (AAS) master token as the canonical `refresh` value and renewal
 * re-runs the master-token exchange, because the short-lived `ya29...` access
 * token it mints outlives faster than the master token.
 */

const tokenURL = "https://android.googleapis.com/auth"
const userAgent = "GoogleAuth/1.4"
/** Google Play services identity the AAS exchange is performed as. */
const app = "com.google.android.googlequicksearchbox"
const clientSig = "38918a453d07199354f8b19af05ec6562ced5788"
const deviceCountry = "id"
const playServicesVersion = "263332035"
const sdkVersion = "35"
/**
 * Scopes requested from the exchange. The Gemini API needs
 * `generative-language`; the remaining scopes let the same master token serve
 * the other Google APIs reachable from an Android account. AAS takes the
 * `oauth2:` scheme marker once, on the first scope only.
 */
const scopes = [
  "https://www.googleapis.com/auth/assistant",
  "https://www.googleapis.com/auth/generative-language",
  "https://www.googleapis.com/auth/photos.image.readonly",
  "https://www.googleapis.com/auth/drive",
]
const service = `oauth2:${scopes.join(" ")}`
/** AAS reports a 1 hour lifetime; assume a shorter one when it does not say. */
const assumedAccessLifetime = 55 * 60 * 1000

/**
 * Metadata flag on credentials minted from an AAS master token. The model
 * resolver reads it to hand the access token to the `google` package as a
 * bearer credential, because the package's default OAuth path posts the
 * token as `x-goog-api-key` and the API answers `API_KEY_INVALID`.
 */
export const AAS_METADATA = "aas:true"

const googleIntegration = Integration.ID.make("google")
const methodID = Integration.MethodID.make("aas")

export interface Master {
  androidId?: string
  Email?: string
  token: string
}

const readString = (value: unknown) => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().replace(/^'+|'+$/g, "").trim()
  return trimmed ? trimmed : undefined
}

/**
 * Accept either a bare master token or the `androidId`/`Email`/`Token` query
 * string Google and Android tooling store alongside it.
 */
export function parseMaster(input: string): Master {
  const trimmed = input.trim().replace(/^"+|"+$/g, "").trim()
  const unescaped = (() => {
    try {
      return decodeURIComponent(trimmed)
    } catch {
      return trimmed
    }
  })()

  if (unescaped.startsWith("aas_et/")) return { token: unescaped }

  const query = new URLSearchParams(unescaped)
  const token = readString(query.get("Token")) ?? readString(query.get("token"))
  if (token)
    return {
      token,
      androidId: readString(query.get("androidId")),
      Email: readString(query.get("Email")),
    }

  const marker = trimmed.indexOf("aas_et")
  if (marker >= 0) return { token: unescaped.slice(marker) }

  throw new Error("No AAS master token found. Paste aas_et/... or androidId=...&Email=...&Token=...")
}

/**
 * AAS answers with a `key=value` block separated by spaces, commas and
 * semicolons, with quoted values and space-containing lists such as
 * `grantedScopes`. Unkeyed tokens continue the previous value.
 */
export function parseResponse(body: string) {
  const fields = new Map<string, string>()
  let lastKey: string | undefined
  for (const chunk of body.split(/[\s,;]+/)) {
    const token = chunk.replace(/^'+|'+$/g, "")
    if (!token) continue
    const separator = token.indexOf("=")
    if (separator > 0) {
      const key = token.slice(0, separator)
      const value = token.slice(separator + 1)
      fields.set(key, fields.has(key) ? `${fields.get(key)},${value}` : value)
      lastKey = key
    } else if (lastKey) {
      fields.set(lastKey, `${fields.get(lastKey)} ${token}`)
    }
  }
  return fields
}

function readExpiry(fields: Map<string, string>) {
  const expiry = Number(fields.get("Expiry"))
  if (Number.isFinite(expiry) && expiry > 0) return expiry * 1000
  const duration = Number(fields.get("ExpiresInDurationSec"))
  if (Number.isFinite(duration) && duration > 0) return Date.now() + duration * 1000
  return Date.now() + assumedAccessLifetime
}

/** Exchanges an AAS master token for a short-lived OAuth access token. */
export const exchange = Effect.fn("GooglePlugin.exchange")(function* (master: Master, email?: string) {
  const response = yield* Effect.tryPromise({
    try: async () =>
      await fetch(tokenURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent,
        },
        body: new URLSearchParams({
          Token: master.token,
          Email: master.Email ?? email ?? "",
          service,
          app,
          callerPkg: app,
          client_sig: clientSig,
          callerSig: clientSig,
          source: "android",
          device_country: deviceCountry,
          lang: "en_US",
          sdk_version: sdkVersion,
          google_play_services_version: playServicesVersion,
          ...(master.androidId ? { androidId: master.androidId } : {}),
        }),
      }),
    catch: (cause) => new Error(`Google AAS token exchange request failed: ${String(cause)}`),
  })
  const text = yield* Effect.tryPromise({
    try: () => response.text().catch(() => ""),
    catch: (cause) => new Error(`Google AAS token exchange failed: ${String(cause)}`),
  })
  if (!response.ok)
    throw new Error(`Google AAS token exchange failed (${String(response.status)}): ${text.slice(0, 400)}`)

  const fields = parseResponse(text)
  const failure = readString(fields.get("Error"))
  if (failure) throw new Error(`Google AAS token exchange rejected the master token: ${failure}`)

  const access = readString(fields.get("Auth"))
  if (!access) throw new Error(`Google AAS token exchange returned no Auth value: ${text.slice(0, 400)}`)

  // The AAS master token is what renews the access token, so it occupies the canonical `refresh` slot.
  return Credential.OAuth.make({
    type: "oauth",
    methodID,
    refresh: master.token,
    access,
    expires: readExpiry(fields),
    metadata: {
      [AAS_METADATA]: true,
      ...(email ? { aas_email: email } : {}),
      ...(master.androidId ? { aas_android_id: master.androidId } : {}),
    },
  })
})

const masterFromCredential = Effect.fn("GooglePlugin.masterFromCredential")(function* (credential: Credential.OAuth) {
  const token = readString(credential.refresh)
  if (!token)
    return yield* Effect.fail(
      new Error("Google AAS credential cannot renew itself. Log in again to enter a new AAS token."),
    )
  const metadata = credential.metadata
  return {
    token,
    androidId: readString(metadata?.aas_android_id),
    Email: readString(metadata?.aas_email),
  }
})

const oauth = (): IntegrationOAuthMethodRegistration => ({
  integrationID: googleIntegration,
  method: {
    id: "aas",
    type: "oauth",
    label: "Google Gemini (Android AAS)",
    form: [
      {
        type: "string",
        key: "email",
        title: "Google account email for the AAS token",
        description:
          "Optional when the pasted auth string already includes Email=...; the AAS exchange cross-checks the account, so a bare aas_et token needs it",
        format: "email",
        placeholder: "you@gmail.com",
      },
    ],
  },
  authorize: (answer) => {
    const email = readString(answer.email)
    return Effect.succeed({
      mode: "code" as const,
      // No provider-hosted page grants the AAS master token; it lives on the
      // device that ran the Android auth flow, so there is no URL to open.
      url: "",
      instructions:
        "Paste the Google AAS master token when prompted: aas_et/... or the full androidId=...&Email=...&Token=... auth string it belongs to",
      callback: (code: string) =>
        Effect.gen(function* () {
          let master: Master
          try {
            master = parseMaster(code)
          } catch (cause) {
            return yield* Effect.fail(cause)
          }
          const address = readString(master.Email) ?? email
          if (!address) return yield* Effect.fail(new Error("Missing Google account email for the AAS master token"))
          return yield* exchange(master, address)
        }),
    })
  },
  refresh: (credential) =>
    Effect.gen(function* () {
      const master = yield* masterFromCredential(credential)
      return yield* exchange(master, master.Email)
    }),
  label: (credential) => {
    const email = readString(credential.metadata?.aas_email)
    return email ? `Google AAS (${email})` : undefined
  },
})

export const GooglePlugin = define({
  id: "opencode.provider.google.aas",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((editor) => {
      editor.method.update(oauth())
    })
  }),
} satisfies PluginInternal.InternalPlugin)
