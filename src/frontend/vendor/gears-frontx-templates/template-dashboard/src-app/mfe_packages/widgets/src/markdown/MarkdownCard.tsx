import { useMemo } from 'react';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import type { WidgetTexts } from '../states';
import type { MarkdownCardRender } from '../types';
import styles from '../widgets.module.css';
import { renderMarkdown } from './markdownModel';

/**
 * The `markdown_card` widget: its markdown `body`, rendered as CommonMark by markdown-it with raw
 * HTML off, and the link and image safety of cpt-frontx-dashboard-algo-widget-catalog-markdown
 * applied in markdown-it's renderer rules. It is not a data widget: it takes no data, shows no data
 * states, and sends no request. The cell's `label`, `locale`, `texts` and `container` are accepted
 * like every widget takes them, but the body is its own text and carries its own names, so the card
 * uses none of them.
 */
export function MarkdownCard({
  payload,
}: {
  payload: RenderWidgetPayload<MarkdownCardRender>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const body = payload.render.body;
  const html = useMemo(() => renderMarkdown(body), [body]);
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: html }} />;
}
