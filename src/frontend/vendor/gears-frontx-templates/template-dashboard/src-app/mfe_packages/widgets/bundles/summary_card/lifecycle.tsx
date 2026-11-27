import { SummaryCard } from '../../src/cards/SummaryCard';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `summary_card` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale }) => <SummaryCard payload={payload as never} locale={locale} />;

export default createWidgetLifecycle(render);
