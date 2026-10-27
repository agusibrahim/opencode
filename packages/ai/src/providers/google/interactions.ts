import type { Auth } from "../../route/auth.js"
import { configure, config } from "../google.js"
import type { ProviderPackage } from "../../provider-package.js"
import type { GoogleInteractions } from "../../protocols/google-interactions.js"

export type Settings = ProviderPackage.Settings &
  GoogleInteractions.ProviderOptionsInput & {
    readonly apiKey?: string
    readonly auth?: Auth.Definition
    readonly baseURL?: string
  }

export const model: ProviderPackage.Definition<Settings, GoogleInteractions.ProviderOptionsInput>["model"] = (
  modelID,
  settings,
) => configure(config(settings)).interactions(modelID)
