import { Schema } from "effect"

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String
  }
) {}

export class ExternalApiError extends Schema.TaggedErrorClass<ExternalApiError>()(
  "ExternalApiError",
  {
    provider: Schema.String,
    message: Schema.String,
    cause: Schema.String
  }
) {}
