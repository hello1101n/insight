export function consumeOverrideParam(): "navigating" | "absent" {
  const url = new URL(window.location.href);
  const target = url.searchParams.get("__override");
  if (!target) return "absent";
  url.searchParams.delete("__override");
  const returnTo = url.pathname + url.search;
  window.location.assign(
    `/auth/login?__override=${encodeURIComponent(target)}&return_to=${encodeURIComponent(returnTo)}`
  );
  return "navigating";
}
