import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { Headers } from "effect/http"
import { LLM } from "@opencode/ai/effect"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { ID, Info, Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { GooglePlugin } from "@opencode/core/plugin/provider/google"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const googleIntegration = Integration.ID.make("google")
const aasMethod = Integration.MethodID.make("aas")
const MASTER = "aas_et/AK99testmastertoken"
const ACCESS_1 = "ya29.first-access"
const ACCESS_2 = "ya29.renewed-access"
const TOKEN_URL = "https://android.googleapis.com/auth"

const aasBody = (access: string) =>
  [
    `SID=${crypto.randomUUID()}`,
    `LSID=${crypto.randomUUID()}`,
    `Auth=${access}`,
    `Expiry=${Math.floor((Date.now() + 3_600_000) / 1000)}`,
    "Email=me@example.com",
    "grantedScopes=oauth2:https://www.googleapis.com/auth/generative-language",
  ].join("\n")

const withAasFetch = <A, E, R>(
  access: string,
  use: (state: { sent: () => { url: string; body: string } | undefined }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const original = globalThis.fetch
      let sent: { url: string; body: string } | undefined
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
        if (url !== TOKEN_URL) return Response.json({}, { status: 404 })
        const body = String(init?.body ?? new URLSearchParams())
        sent = { url, body: new URLSearchParams(body).toString() }
        return new Response(aasBody(access), { status: 200 })
      }) as unknown as typeof fetch
      return {
        release: Effect.sync(() => {
          globalThis.fetch = original
        }),
        sent: () => sent,
      }
    }),
    (state) => use(state),
    (state) => state.release,
  )

const addPlugin = Effect.fn(function* () {
  const providers = yield* Provider.Service
  yield* providers.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(Provider.ID.google),
        name: "Google",
        package: "@opencode/ai/providers/google",
        activation: "enabled",
      },
      models: [Model.Info.default(Provider.ID.google, Model.ID.make("gemini-2.5-flash"))],
    })
  })
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* GooglePlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

/** A catalog model row served by the native google package, as models.dev lists them. */
const catalogModel = () => {
  const info: Model.MutableInfo = {
    id: ID.make("test-model"),
    modelID: ID.make("gemini-2.5-flash"),
    providerID: Provider.ID.google,
    name: "Test model",
    package: "@opencode/ai/providers/google",
    settings: { baseURL: "https://generativelanguage.googleapis.com/v1beta" },
    headers: {},
    body: {},
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  }
  return Info.make(info)
}

const aasCredential = (expires: number) => (access: string) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: aasMethod,
    refresh: MASTER,
    access,
    expires,
    metadata: { "aas:true": true, aas_email: "me@example.com" },
  })

describe("GooglePlugin", () => {
  it.effect("registers the Android AAS OAuth method on Google", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      const integrations = yield* Integration.Service
      expect((yield* integrations.get(googleIntegration))?.methods).toContainEqual({
        id: aasMethod,
        type: "oauth",
        label: "Google Gemini (Android AAS)",
        form: expect.any(Array),
      })
    }),
  )

  it.effect("exchanges the pasted AAS master token for an access token", () =>
    withAasFetch(ACCESS_1, () =>
      Effect.gen(function* () {
        yield* addPlugin()
        const integrations = yield* Integration.Service
        const attempt = yield* integrations.oauth.connect({
          integrationID: googleIntegration,
          methodID: aasMethod,
          answer: { email: "me@example.com" },
        })
        expect(attempt.mode).toBe("code")
        yield* integrations.oauth.complete({
          integrationID: googleIntegration,
          attemptID: attempt.attemptID,
          code: MASTER,
        })
        const credentials = yield* Credential.Service
        const [saved, ...rest] = yield* credentials.list(googleIntegration)
        expect(rest).toHaveLength(0)
        expect(saved.value).toEqual({
          ...aasCredential(0)(ACCESS_1),
          expires: expect.any(Number),
        })
      }),
    ),
  )

  it.effect("sends the AAS exchange request with the Play services identity", () =>
    withAasFetch(ACCESS_1, (state) =>
      Effect.gen(function* () {
        yield* addPlugin()
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: googleIntegration,
          label: "Google AAS",
          value: aasCredential(1)(ACCESS_1),
        })
        const integrations = yield* Integration.Service
        const connection = required(yield* integrations.connection.active(googleIntegration))
        yield* integrations.connection.resolve(connection)
        const sent = required(state.sent())
        const body = new URLSearchParams(sent.body)
        expect(body.get("Token")).toBe(MASTER)
        expect(body.get("Email")).toBe("me@example.com")
        expect(body.get("service")).toContain("oauth2:")
        expect(body.get("service")).toContain("generative-language")
        expect(body.get("app")).toBe("com.google.android.googlequicksearchbox")
        expect(body.get("client_sig")).toBe("38918a453d07199354f8b19af05ec6562ced5788")
        expect(body.get("google_play_services_version")).toBe("263332035")
      }),
    ),
  )

  it.effect("renews the access token from the stored master token", () =>
    withAasFetch(ACCESS_2, () =>
      Effect.gen(function* () {
        yield* addPlugin()
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: googleIntegration,
          label: "Google AAS",
          value: aasCredential(1)(ACCESS_1),
        })
        const integrations = yield* Integration.Service
        const connection = required(yield* integrations.connection.active(googleIntegration))
        const value = required(yield* integrations.connection.resolve(connection))
        expect(value).toEqual({
          ...aasCredential(0)(ACCESS_2),
          expires: expect.any(Number),
        })
      }),
    ),
  )

  it.effect("reports the missing account email for a bare master token", () =>
    withAasFetch(ACCESS_1, () =>
      Effect.gen(function* () {
        yield* addPlugin()
        const integrations = yield* Integration.Service
        const attempt = yield* integrations.oauth.connect({
          integrationID: googleIntegration,
          methodID: aasMethod,
        })
        const exit = yield* Effect.exit(
          integrations.oauth.complete({
            integrationID: googleIntegration,
            attemptID: attempt.attemptID,
            code: MASTER,
          }),
        )
        const cause = required(Exit.match(exit, { onFailure: (cause) => cause, onSuccess: () => undefined }))
        const error = Option.getOrUndefined(Cause.findErrorOption(cause))
        expect(String((error as Error | undefined)?.message ?? error)).toContain("email")
        const credentials = yield* Credential.Service
        expect(yield* credentials.list(googleIntegration)).toHaveLength(0)
      }),
    ),
  )

  it.effect("threads the AAS access token into the google package as Authorization bearer", () =>
    withAasFetch(ACCESS_1, () =>
      Effect.gen(function* () {
        yield* addPlugin()
        const resolved = yield* ModelResolver.fromCatalogModel(
          catalogModel(),
          aasCredential(Date.now() + 30 * 60_000)(ACCESS_1),
        )
        const headers = yield* resolved.route.auth.apply({
          request: LLM.request({ model: resolved, prompt: "Hello" }),
          method: "POST",
          url: resolved.route.endpoint.baseURL ?? "",
          body: "{}",
          headers: Headers.fromInput(resolved.route.defaults.headers),
        })
        // OAuth access tokens are accepted only as `Authorization: Bearer`; `x-goog-api-key`
        // answers `API_KEY_INVALID`.
        expect(headers.authorization).toBe(`Bearer ${ACCESS_1}`)
        expect(headers["x-goog-api-key"]).toBeUndefined()
      }),
    ),
  )

  it.effect("keeps the apiKey path for a plain Google API key credential", () =>
    withAasFetch(ACCESS_1, () =>
      Effect.gen(function* () {
        yield* addPlugin()
        const resolved = yield* ModelResolver.fromCatalogModel(
          catalogModel(),
          Credential.Key.make({ type: "key", key: "gemini-api-key" }),
        )
        const headers = yield* resolved.route.auth.apply({
          request: LLM.request({ model: resolved, prompt: "Hello" }),
          method: "POST",
          url: resolved.route.endpoint.baseURL ?? "",
          body: "{}",
          headers: Headers.fromInput(resolved.route.defaults.headers),
        })
        expect(headers["x-goog-api-key"]).toBe("gemini-api-key")
        expect(headers.authorization).toBeUndefined()
      }),
    ),
  )
})
