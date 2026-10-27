import type { RouteDefaultsInput } from "../route/client.js"
import { Auth } from "../route/auth.js"
import type { ProviderAuthOption } from "../route/auth-options.js"
import { MediaRoute } from "../route/media.js"
import type { ProviderPackage } from "../provider-package.js"
import { ProviderID, type ModelID, type ProviderOptions } from "../schema/index.js"
import { Gemini } from "../protocols/gemini.js"
import { GoogleInteractions } from "../protocols/google-interactions.js"
import { GoogleImages } from "../protocols/google-images.js"
import { GoogleSpeech } from "../protocols/google-speech.js"
import { GoogleTranscription } from "../protocols/google-transcription.js"
import { GoogleVideo } from "../protocols/google-video.js"

export type { GoogleImageOptions } from "../protocols/google-images.js"
export type { GoogleSpeechOptions } from "../protocols/google-speech.js"
export type { GoogleTranscriptionOptions } from "../protocols/google-transcription.js"
export type { GoogleVideoOptions } from "../protocols/google-video.js"
export type GeminiOptionsInput = Gemini.OptionsInput
export type GeminiProviderOptionsInput = Gemini.ProviderOptionsInput
export type GoogleInteractionsOptionsInput = GoogleInteractions.OptionsInput

export const id = ProviderID.make("google")

export const routes = [Gemini.route, GoogleInteractions.route]

export type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: Gemini.ProviderOptionsInput & GoogleInteractions.ProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  Gemini.ProviderOptionsInput & {
    readonly apiKey?: string
    readonly auth?: Auth.Definition
    readonly baseURL?: string
  }

const hasAuthorizationHeader = (headers: Readonly<Record<string, string>> | undefined) =>
  headers !== undefined && Object.keys(headers).some((key) => key.toLowerCase() === "authorization")

const auth = (options: ProviderAuthOption<"optional"> | { headers?: Readonly<Record<string, string>> }) => {
  if ("auth" in options && options.auth) return options.auth
  // The API accepts OAuth access tokens only as `Authorization: Bearer <token>`; sending one as
  // `x-goog-api-key` fails with `API_KEY_INVALID` even though a real Gemini API key works there.
  // A caller-supplied Authorization header (e.g. the Google AAS credential) selects the bearer
  // path, where the route's default headers carry the token and no credential lookup happens.
  if (hasAuthorizationHeader("headers" in options ? options.headers : undefined)) return Auth.none
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("GOOGLE_GENERATIVE_AI_API_KEY"))
    .pipe(Auth.header("x-goog-api-key"))
}

const configuredRoute = (input: Config) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return Gemini.route.with({ ...rest, endpoint: { baseURL }, auth: auth(input) })
}

const interactionsRoute = (input: Config) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return GoogleInteractions.route.with({ ...rest, endpoint: { baseURL }, auth: auth(input) })
}

export const configure = (input: Config = {}) => {
  const route = configuredRoute(input)
  const media = MediaRoute.deployment(input, auth(input))
  return {
    id,
    model: (modelID: string | ModelID) => route.model<Gemini.ProviderOptionsInput>({ id: modelID }),
    interactions: (modelID: string | ModelID) =>
      interactionsRoute(input).model<GoogleInteractions.ProviderOptionsInput>({ id: modelID }),
    image: (modelID: string | ModelID, providerOptions?: ProviderOptions) =>
      GoogleImages.model({ ...media, id: modelID, providerOptions }),
    video: (modelID: string | ModelID) => GoogleVideo.model({ ...media, id: modelID }),
    speech: (modelID: string | ModelID) => GoogleSpeech.model({ ...media, id: modelID }),
    transcription: (modelID: string | ModelID) => GoogleTranscription.model({ ...media, id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model: ProviderPackage.Definition<Settings, Gemini.ProviderOptionsInput>["model"] = (modelID, settings) =>
  configure(config(settings)).model(modelID)
export const imageModel = (modelID: string, settings: Settings) => {
  const input = config(settings)
  return configure(input).image(modelID, input.providerOptions)
}

/**
 * Shapes the package's settings into a `Config`. The route auth option is a
 * union, so an explicit `auth` definition (e.g. the model resolver's bearer
 * credential for AAS) excludes the `apiKey` field it would otherwise shadow.
 */
export function config(settings: Settings): Config {
  const { apiKey, auth, baseURL, body, headers, ...providerOptions } = settings
  const http = body === undefined ? undefined : { body }
  if (auth) return { auth, baseURL, headers, http, providerOptions }
  return { apiKey, baseURL, headers, http, providerOptions }
}

export const image = provider.image
export const interactions = provider.interactions
export const video = provider.video
export const speech = provider.speech
export const transcription = provider.transcription
