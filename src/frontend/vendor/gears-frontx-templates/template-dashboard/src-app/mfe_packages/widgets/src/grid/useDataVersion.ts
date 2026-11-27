import { useRef } from 'react';

/**
 * A number that changes whenever `data` changes (by identity; pass a string to compare content). The kit DataGrid
 * keeps the records it loaded and does not reload when its load callback
 * changes, so a grid keyed by this number remounts and loads the new data.
 */
export function useDataVersion(data: unknown): number {
  const seen = useRef<{ data: unknown; version: number }>({ data, version: 0 });
  if (seen.current.data !== data) seen.current = { data, version: seen.current.version + 1 };
  return seen.current.version;
}
