import { useState, type ReactNode } from 'react';
import { ChartLineIcon, Table2Icon } from 'lucide-react';
import { Button } from '@gears-frontx/ui-kit';

import type { WidgetTexts } from '../states';
import styles from '../widgets.module.css';
import { useDataVersion } from '../grid/useDataVersion';
import { DataView, type ValuesTable } from './DataView';

/** What a chart draws given the pick handler: a click on a mark picks the row of the values table it stands for. */
export type DrawChart = (onPick: ((row: number) => void) | undefined) => ReactNode;

/**
 * Holds a chart and, when `drill_down` is on, its data view: a button switches
 * between them, and a click on a mark opens the data view with that mark's row
 * picked. With drill-down off the chart draws no clickable marks.
 */
export function ChartShell({
  drillDown,
  laidOut = true,
  table,
  draw,
  label,
  texts,
  format,
  locale,
  container,
}: {
  drillDown: boolean;
  /**
   * Whether the chart's measured box is laid out (`isLaidOut`); the chart is drawn only then. A chart drawn with the
   * chart library passes it; one drawn without it (the funnel, the heatmap) leaves it out.
   */
  laidOut?: boolean;
  table: ValuesTable;
  draw: DrawChart;
  label: string;
  texts: WidgetTexts;
  format: (value: string | number | null, column: number, row: number) => string;
  locale: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const [view, setView] = useState<{ data: boolean; picked: number | null; version: number }>({ data: false, picked: null, version: 0 });
  // A pick names a row of the values the chart had then; new values drop it, so no other point is opened in its place.
  // The content key is built only with drill-down on: without it nothing is picked, and a chart redraws on every resize.
  // It covers the rows only: a new language renames the headings and keeps the pick.
  const version = useDataVersion(drillDown ? JSON.stringify(table.rows) : null);
  const picked = view.version === version ? view.picked : null;
  if (!drillDown) return <div className={styles.chart}>{laidOut ? draw(undefined) : null}</div>;
  return (
    <div className={styles.chartShell}>
      <div className={styles.chartActions}>
        {/* The label names the view the button opens, so the button carries no pressed state, which would contradict it. */}
        <Button variant="ghost" size="sm" icon={view.data ? <ChartLineIcon /> : <Table2Icon />} onClick={() => setView({ data: !view.data, picked: null, version })}>
          {view.data ? texts.showChart : texts.showData}
        </Button>
      </div>
      {view.data ? (
        <DataView key={picked ?? 'all'} table={table} version={version} picked={picked} label={label} format={format} locale={locale} container={container} />
      ) : (
        <div className={`${styles.chart} ${styles.clickable}`}>{laidOut ? draw((row) => setView({ data: true, picked: row, version })) : null}</div>
      )}
    </div>
  );
}
