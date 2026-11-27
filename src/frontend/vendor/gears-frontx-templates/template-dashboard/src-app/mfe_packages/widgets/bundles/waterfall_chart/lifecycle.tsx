import { WaterfallChart } from '../../src/chart/WaterfallChart';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `waterfall_chart` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <WaterfallChart payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
