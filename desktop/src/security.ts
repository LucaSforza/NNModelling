import type { WebPreferences } from "electron"

export const MAIN_WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} satisfies WebPreferences)

export function isAllowedNavigation(url: string, developmentUrl?: string): boolean {
  if (url.startsWith("app://nnmodelling/")) return true
  if (!developmentUrl) return false
  try {
    return new URL(url).origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}
