import * as React from "react";

export type ShellLayout = "phone" | "narrow" | "wide";

// WORKAROUND: the kit renders its sidebar as a Sheet driven by `openMobile` below 768px.
const PHONE_MQ = "(max-width: 767px)";
const NARROW_MQ = "(min-width: 768px) and (max-width: 1023px)";

function subscribe(cb: () => void): () => void {
  const queries = [window.matchMedia(PHONE_MQ), window.matchMedia(NARROW_MQ)];
  for (const q of queries) q.addEventListener("change", cb);
  return () => {
    for (const q of queries) q.removeEventListener("change", cb);
  };
}

function getSnapshot(): ShellLayout {
  if (window.matchMedia(PHONE_MQ).matches) return "phone";
  if (window.matchMedia(NARROW_MQ).matches) return "narrow";
  return "wide";
}

function getServerSnapshot(): ShellLayout {
  return "wide";
}

export function useShellLayout(): ShellLayout {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
