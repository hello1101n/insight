import { useEffect } from 'react';

/**
 * The kit DataGrid names each sortable header as a button ("Change sorting of
 * '<label>' column") and sets no `aria-sort`. This keeps `aria-sort` on every
 * sortable header cell under `root`: the sorted column's direction, `none` on
 * the others; `occurrence` picks the sorted one among headers that share its
 * label. `root` comes from a callback ref, so a grid that mounts after an
 * empty or failed state is still seen. The grid draws its headers after its
 * first load and redraws them on its own, so a MutationObserver re-applies the
 * state whenever they change, including a renamed header whose button keeps its node.
 */
export function useAriaSort(root: HTMLElement | null, sortedLabel: string | undefined, direction: 'asc' | 'desc' | undefined, occurrence = 0) {
  useEffect(() => {
    if (!root) return;
    // The kit's exact button name, so a title that ends like another ("Other 'Total") cannot match.
    const name = sortedLabel === undefined ? undefined : `Change sorting of '${sortedLabel}' column`;
    const apply = () => {
      // Headers follow column order, so among headers with the same label the sorted one is the occurrence-th.
      let seen = 0;
      root.querySelectorAll('th').forEach((header) => {
        const label = header.querySelector('button[aria-label]')?.getAttribute('aria-label');
        if (!label) return;
        const match = name !== undefined && label === name && seen++ === occurrence;
        const value = match && direction !== undefined ? (direction === 'asc' ? 'ascending' : 'descending') : 'none';
        if (header.getAttribute('aria-sort') !== value) header.setAttribute('aria-sort', value);
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
    return () => observer.disconnect();
  }, [root, sortedLabel, direction, occurrence]);
}
