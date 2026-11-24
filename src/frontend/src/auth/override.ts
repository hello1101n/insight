export function consumeOverrideParam(): boolean {
  const url = new URL(window.location.href);
  const target = url.searchParams.get("__override");
  if (!target) return false;
  url.searchParams.delete("__override");
  const returnTo = url.pathname + url.search;
  window.location.assign(
    `/auth/login?__override=${encodeURIComponent(target)}&return_to=${encodeURIComponent(returnTo)}`
  );
  return true;
}
