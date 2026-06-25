import { Context, Layer } from "effect"

export interface AppConfig {
  readonly port: number
  readonly databaseFile: string
  readonly slackAppToken: string | null
  readonly slackUserToken: string | null
  readonly mySlackUserId: string | null
  readonly linearApiKey: string | null
  readonly linearWorkspaceUrl: string | null
  readonly githubToken: string | null
}

export class AppConfigService extends Context.Service<AppConfigService, AppConfig>()("AppConfigService") {
  static layerFromConfig(config: AppConfig) {
    return Layer.succeed(this, config)
  }
}

const envString = (name: string): string | null => {
  const value = process.env[name]
  return value === undefined || value.trim() === "" ? null : value
}

const envNumber = (name: string, fallback: number): number => {
  const value = envString(name)
  if (value === null) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const readConfig = (): AppConfig => {
  return {
    port: envNumber("PORT", 8787),
    databaseFile: envString("DATABASE_FILE") ?? "./slack-thread-monitor.sqlite",
    slackAppToken: envString("SLACK_APP_TOKEN"),
    slackUserToken: envString("SLACK_USER_TOKEN"),
    mySlackUserId: envString("MY_SLACK_USER_ID"),
    linearApiKey: envString("LINEAR_API_KEY"),
    linearWorkspaceUrl: envString("LINEAR_WORKSPACE_URL"),
    githubToken: envString("GITHUB_TOKEN")
  }
}
