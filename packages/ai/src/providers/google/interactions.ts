import type { Auth } from "../../route/auth.js"
import { configure, config } from "../google.js"
import type { ProviderPackage } from "../../provider-package.js"
import type { GoogleInteractions } from "../../protocols/google-interactions.js"

export type Settings = ProviderPackage.Settings &
  GoogleInteractions.ProviderOptionsInput & {
    readonly apiKey?: string | false
    readonly auth?: Auth.Definition
    readonly baseURL?: string
  }

export const model: ProviderPackage.Model<Settings, GoogleInteractions.ProviderOptionsInput> = (modelID, settings) =>
  configure(config(settings)).interactions(modelID)
