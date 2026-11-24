import type { CSSProperties } from 'react';
import { Progress, Text } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, isOutsideRange, nonFiniteProblemOf, percentInRange, progressOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { ProgressListCardData, ProgressListCardRender } from '../types';
import styles from '../widgets.module.css';

/**
 * The share of its track a bar fills, 0 to 100: in proportion to `current` over `target`, full when `current`
 * reaches or exceeds `target` and never full below it (the shared reached rule), and empty for a null `current` or
 * a null or zero `target`.
 */
const shareOf = (current: number | null, target: number | null): number => {
  if (current === null || target === null || target <= 0) return 0;
  return progressOf(current / target).filled;
};

/**
 * Where a goal's mark stands on its bar, 0 to 100, and whether the goal lies outside the bar. The bar runs from 0 to
 * `target`: a goal outside it extends nothing, its mark stands at the nearer end and the text says it is outside. With
 * a null or zero target the bar has no range, so the goal draws no mark and shows in the text alone.
 */
const goalOf = (goal: number, target: number | null): { at: number | null; outside: boolean } => {
  if (target === null || target <= 0) return { at: null, outside: false };
  const share = goal / target;
  return { at: percentInRange(share), outside: isOutsideRange(share) };
};

/**
 * The `progress_list_card` widget: one bar per data row, in delivered order, filling by `current` over
 * `target`, with the current and target values as text so the bar does not carry meaning alone. The cell's
 * `label` and `container` are accepted like every widget takes them, but a card draws no overlay and its
 * rows are its own text, so it uses neither.
 */
export function ProgressListCard({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
}: {
  payload: RenderWidgetPayload<ProgressListCardRender, ProgressListCardData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  if (!data) return <WidgetCannotBeShown texts={texts} problem="progress_list_card: no data" />;
  const nonFinite = nonFiniteProblemOf('progress_list_card', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  if (data.rows.length === 0) return <WidgetEmpty texts={texts} />;

  return (
    <ul className={styles.progressList}>
      {/* The rows keep their delivered place: a null label is an empty one, and the row stays. */}
      {data.rows.map((row, index) => {
        // One missing side shows as a plain hyphen, so the row keeps saying which side it lacks; with both sides missing it shows no values.
        const current = formatValue(row.current, value_format, locale);
        const target = formatValue(row.target, value_format, locale);
        const valueText = current === '' && target === '' ? '' : `${current || '-'} ${texts.progress.of} ${target || '-'}`;
        const goal = typeof row.goal === 'number' ? { value: row.goal, ...goalOf(row.goal, row.target) } : null;
        // The goal, with its name, is in the bar's value text and the mark's tooltip; a goal outside the bar says so.
        const goalText = goal ? `${render.goal_label ?? texts.progress.goal}: ${formatValue(goal.value, value_format, locale)}${goal.outside ? `, ${texts.progress.goalOutside}` : ''}` : '';
        const ariaText = [valueText, goalText].filter(Boolean).join(', ');
        return (
          <li key={index} className={styles.progressRow}>
            <div className={styles.progressHead}>
              <Text typography="label" render={<span />}>
                {row.label ?? ''}
              </Text>
              <Text typography="meta" tone="muted" render={<span />}>
                {valueText}
              </Text>
            </div>
            {/* Named by its label, with its current and target values and its goal as its value text; hovering the bar shows the goal. */}
            <div className={styles.progressBar} title={goalText || undefined}>
              <Progress value={shareOf(row.current, row.target)} aria-label={row.label === null ? undefined : String(row.label)} getAriaValueText={() => ariaText} />
              {goal && goal.at !== null ? <span className={styles.progressGoal} style={{ '--goal-at': `${goal.at}%` } as CSSProperties} aria-hidden /> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
