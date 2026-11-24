export interface InsightRuntimeConfig {
  sentryDsn?: string;
  nav?: { hide?: readonly string[]; planned?: readonly string[] };
}

declare global {
  interface Window {
    __INSIGHT_CONFIG__?: InsightRuntimeConfig;
  }
}

export function runtimeConfig(): InsightRuntimeConfig {
  return window.__INSIGHT_CONFIG__ ?? {};
}
