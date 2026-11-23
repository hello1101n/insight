import { chartColor } from "@/lib/chart-palette";

const BRAND_BY_SEED: ReadonlyMap<string, string> = new Map([
  ["slack", "var(--brand-slack)"],
  ["m365", "var(--brand-m365)"],
  ["zoom", "var(--brand-zoom)"],
  ["zulip", "var(--brand-zulip)"],
  ["zulip_proxy", "var(--brand-zulip)"],
  ["github", "var(--brand-github)"],
  ["gitlab", "var(--brand-gitlab)"],
  ["bitbucket_cloud", "var(--brand-bitbucket)"],
  ["bitbucket_server", "var(--brand-bitbucket-server)"],
  ["cursor", "var(--brand-cursor)"],
  ["claude", "var(--brand-claude)"],
  ["claude_code", "var(--brand-claude-code)"],
  ["chatgpt", "var(--brand-chatgpt)"],
  ["codex", "var(--brand-codex)"],
  ["openai", "var(--brand-openai)"],
  ["copilot", "var(--brand-copilot)"],
  ["jetbrains", "var(--brand-jetbrains)"],
  ["windsurf", "var(--brand-windsurf)"],
  ["jira", "var(--brand-jira)"],
  ["youtrack", "var(--brand-youtrack)"],
  ["hubspot", "var(--brand-hubspot)"],
  ["salesforce", "var(--brand-salesforce)"],
  ["jsm", "var(--brand-jsm)"],
  ["zendesk", "var(--brand-zendesk)"],
  ["confluence", "var(--brand-confluence)"],
  ["outline", "var(--brand-outline)"],
  ["allure", "var(--brand-allure)"],
  ["figma", "var(--brand-figma)"],
  ["bamboohr", "var(--brand-bamboohr)"],
  ["workday", "var(--brand-workday)"],
  ["ms_entra", "var(--brand-ms-entra)"],
  ["ldap", "var(--brand-ldap)"],
]);

const FILE_CATEGORY_BY_SEED: ReadonlyMap<string, string> = new Map([
  ["vendored", "var(--muted-foreground)"],
]);

export function seriesColors(seeds: string[]): Record<string, string> {
  // SAFETY: null prototype, so a "__proto__" seed becomes an own key instead of hitting the prototype setter.
  const palette: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const unknown: string[] = [];
  for (const seed of new Set(seeds)) {
    const known = BRAND_BY_SEED.get(seed) ?? FILE_CATEGORY_BY_SEED.get(seed);
    if (known) palette[seed] = known;
    else unknown.push(seed);
  }
  unknown.sort();
  unknown.forEach((seed, index) => {
    palette[seed] = chartColor(index);
  });
  return palette;
}
