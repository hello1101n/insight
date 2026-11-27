import { useEffect, useMemo, type ReactNode } from 'react';
import { Skeleton, Text } from '@gears-frontx/ui-kit';

import type { DashboardCell, DashboardLayout } from './contract';
import { DashboardGrid } from './layout/DashboardGrid';
import { checkLayout, type LayoutFailure } from './layout/layoutChecks';
import styles from './frame/frame.module.css';
import { escapeControls } from './runtime/register';

export interface DashboardTexts {
  loading: string;
  cannotBeShown: string;
}

export const DEFAULT_DASHBOARD_TEXTS: DashboardTexts = {
  loading: 'Loading dashboard',
  cannotBeShown: 'This dashboard cannot be shown',
};

const NO_FAILURES: readonly number[] = [];

const describe = (failure: LayoutFailure) =>
  failure.kind === 'cell'
    ? `cell ${failure.cell} fails the dashboard type`
    : `widget id ${failure.id} repeats in ${failure.at.map(({ cell, role }) => `cell ${cell} (${role})`).join(', ')}`;

/**
 * The dashboard area: the dashboard-level loader, the dashboard-level
 * cannot-be-shown state, or the cells of a layout that passes the layout
 * checks. A failed check mounts no cell and writes its failures to the console.
 */
export function DashboardArea({
  layout,
  cellFailures = NO_FAILURES,
  failed = false,
  renderCell,
  texts = DEFAULT_DASHBOARD_TEXTS,
}: {
  /** Absent while the dashboard loads. */
  layout?: DashboardLayout;
  /** The cell failures the GTS validation of the dashboard reported (see `cellFailuresOf`). */
  cellFailures?: readonly number[];
  /** A dashboard-level failure found before the layout checks (file, type or validation). */
  failed?: boolean;
  renderCell: (cell: DashboardCell, index: number) => ReactNode;
  texts?: DashboardTexts;
}) {
  // The check and its log key on the failures' content, so a caller that builds the list on each render logs once.
  const failuresKey = cellFailures.join(',');
  // A failed dashboard is not checked: its layout may not even have the shape the checks read.
  const result = useMemo(() => (layout && !failed ? checkLayout(layout, cellFailures) : undefined), [layout, failed, failuresKey]);
  // The failures go to the developer log once per checked layout, not on every render.
  useEffect(() => {
    // A repeated widget id comes from the layout as served, so it is escaped as the part lines are.
    if (result && !result.ok) console.error(`[dashboard] ${escapeControls(`layout check failed: ${result.failures.map(describe).join('; ')}`)}`);
  }, [result]);
  if (failed) return <CannotBeShown text={texts.cannotBeShown} />;
  if (!layout || !result) {
    return (
      <div className={styles.loading} role="status" aria-label={texts.loading}>
        <Skeleton className={styles.skeletonBlock} />
      </div>
    );
  }
  if (!result.ok) return <CannotBeShown text={texts.cannotBeShown} />;
  if (layout.cells.length === 0) return null;
  return <DashboardGrid layout={layout} renderCell={renderCell} />;
}

function CannotBeShown({ text }: { text: string }) {
  return (
    <Text tone="muted" render={<p />} className={styles.cannot}>
      {text}
    </Text>
  );
}
