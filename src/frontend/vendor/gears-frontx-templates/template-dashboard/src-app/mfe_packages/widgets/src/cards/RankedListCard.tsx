import { Text } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, nonFiniteProblemOf } from '../format';
import { SafeLink } from '../links';
import { DEFAULT_WIDGET_TEXTS, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import { ToneBadge } from '../tones';
import type { RankedListCardData, RankedListCardRender } from '../types';
import styles from '../widgets.module.css';

/**
 * The `ranked_list_card` widget: one ranked item per data row, in delivered order - the rank is the
 * position, followed by the label, the value and the optional secondary value, under the headings of the
 * two value columns. The cell's `label` and `container` are accepted like every widget takes them, but a
 * card draws no overlay and its rows are its own text, so it uses neither.
 */
export function RankedListCard({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
}: {
  payload: RenderWidgetPayload<RankedListCardRender, RankedListCardData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  if (!data) return <WidgetCannotBeShown texts={texts} problem="ranked_list_card: no data" />;
  const nonFinite = nonFiniteProblemOf('ranked_list_card', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  if (data.rows.length === 0) return <WidgetEmpty texts={texts} />;

  // `secondary` is omitted when the data has no secondary value: then its column and heading hide. An
  // explicit null is a delivered value that shows as an empty one, and the column stays.
  const hasSecondary = data.rows.some((row) => row.secondary !== undefined);

  return (
    <div className={styles.ranked}>
      <div className={styles.rankedHead}>
        <span />
        <span />
        {/* The render labels replace the default headings of the two value columns. */}
        <Text typography="meta" tone="muted" render={<span />} className={styles.rankedValue}>
          {render.value_label ?? texts.ranked.value}
        </Text>
        {hasSecondary ? (
          <Text typography="meta" tone="muted" render={<span />} className={styles.rankedSecondary}>
            {render.secondary_label ?? texts.ranked.secondary}
          </Text>
        ) : null}
      </div>
      <ol className={styles.rankedRows}>
        {/* The rows keep their delivered place: the rank is the position, and a null label is an empty one. */}
        {data.rows.map((row, index) => (
          <li key={index} className={styles.rankedRow}>
            <Text typography="mono" tone="muted" render={<span />}>
              {index + 1}
            </Text>
            {/* The label, a link when the row has a target (the shared rule draws a label with no visible character as text), then the row's status as a badge with its text, so the tone never carries it alone; a status with no visible character draws no badge. */}
            <span className={styles.rankedLabel}>
              <Text typography="label" render={<span />} className={styles.rankedName}>
                {typeof row.href === 'string' ? <SafeLink text={String(row.label ?? '')} href={row.href} texts={texts} /> : (row.label ?? '')}
              </Text>
              {typeof row.status === 'string' ? <ToneBadge text={row.status} tones={render.status_tones} className={styles.rankedStatus} /> : null}
            </span>
            <Text typography="label" render={<span />} className={styles.rankedValue}>
              {formatValue(row.value, value_format, locale)}
            </Text>
            {hasSecondary ? (
              <Text typography="meta" tone="muted" render={<span />} className={styles.rankedSecondary}>
                {formatValue(row.secondary, value_format, locale)}
              </Text>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
