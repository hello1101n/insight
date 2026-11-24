import { Text } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, nonFiniteProblemOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { SummaryCardData, SummaryCardRender } from '../types';
import styles from '../widgets.module.css';

/**
 * The `summary_card` widget: one label/value line per data row, in delivered order. The cell's `label` and
 * `container` are accepted like every widget takes them, but the card draws no overlay and its rows are its
 * own text, so it uses neither.
 */
export function SummaryCard({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
}: {
  payload: RenderWidgetPayload<SummaryCardRender, SummaryCardData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { data, value_format } = payload;
  if (!data) return <WidgetCannotBeShown texts={texts} problem="summary_card: no data" />;
  const nonFinite = nonFiniteProblemOf('summary_card', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  if (data.rows.length === 0) return <WidgetEmpty texts={texts} />;

  return (
    <dl className={styles.summary}>
      {/* The rows keep their delivered place: a null label is an empty one, and the row stays. */}
      {data.rows.map((row, index) => (
        <div key={index} className={styles.summaryRow}>
          <Text typography="meta" tone="muted" render={<dt />}>
            {row.label ?? ''}
          </Text>
          {/* A null value shows as an empty value after its label. */}
          <Text typography="label" render={<dd />}>
            {formatValue(row.value, value_format, locale)}
          </Text>
        </div>
      ))}
    </dl>
  );
}
