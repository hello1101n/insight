import type { DashboardLayout } from '../contract';

export type WidgetRole = 'widget' | 'larger_view';

export type LayoutFailure =
  /** The GTS validation of the dashboard failed under this cell, outside its widgets. */
  | { kind: 'cell'; cell: number }
  /** The same widget id is carried by these cells, in these roles. */
  | { kind: 'repeated-id'; id: string; at: { cell: number; role: WidgetRole }[] };

export type LayoutCheckResult = { ok: true } | { ok: false; failures: LayoutFailure[] };

const CELL_PATH = /^\/layout\/cells\/(\d+)(\/.*)?$/;

/**
 * The cell failures among the instance paths the GTS validation of a dashboard
 * reported: a path under `layout.cells[i]` but not under its `widget` or
 * `larger_view`. Each cell index is named once, in ascending order.
 */
export function cellFailuresOf(instancePaths: readonly string[]): number[] {
  const cells = new Set<number>();
  for (const path of instancePaths) {
    const match = CELL_PATH.exec(path);
    if (!match) continue;
    const rest = match[2] ?? '';
    if (/^\/(widget|larger_view)(\/|$)/.test(rest)) continue;
    cells.add(Number(match[1]));
  }
  return [...cells].sort((a, b) => a - b);
}

// @cpt-algo:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2
/**
 * The layout checks the dashboard root runs on every dashboard load, after the
 * GTS validation of the dashboard. A failed check is a dashboard-level failure.
 */
export function checkLayout(layout: DashboardLayout, cellFailures: readonly number[]): LayoutCheckResult {
  // @cpt-begin:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-cell-failures
  if (cellFailures.length > 0) {
    return { ok: false, failures: [...new Set(cellFailures)].sort((a, b) => a - b).map((cell) => ({ kind: 'cell', cell })) };
  }
  // @cpt-end:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-cell-failures

  // @cpt-begin:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-ids
  const carriers = new Map<string, { cell: number; role: WidgetRole }[]>();
  layout.cells.forEach((cell, index) => {
    for (const role of ['widget', 'larger_view'] as const) {
      const id = cell[role]?.id;
      if (typeof id !== 'string') continue;
      carriers.set(id, [...(carriers.get(id) ?? []), { cell: index, role }]);
    }
  });
  // @cpt-end:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-ids

  // @cpt-begin:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-repeat
  const failures: LayoutFailure[] = [...carriers]
    .filter(([, at]) => at.length > 1)
    .map(([id, at]) => ({ kind: 'repeated-id', id, at }));
  // @cpt-end:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-repeat

  // @cpt-begin:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-return
  return failures.length > 0 ? { ok: false, failures } : { ok: true };
  // @cpt-end:cpt-frontx-dashboard-algo-dashboard-model-layout-checks:p2:inst-dm-check-return
}
