import { MarkdownCard } from '../../src/markdown/MarkdownCard';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `markdown_card` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <MarkdownCard payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
