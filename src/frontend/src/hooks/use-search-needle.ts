import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { SEARCH_DEBOUNCE_MS } from "@/queries/identity-resolution";

export function useSearchNeedle(text: string): string {
  const typed = text.trim();
  const debounced = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);
  return typed === "" ? "" : debounced;
}
