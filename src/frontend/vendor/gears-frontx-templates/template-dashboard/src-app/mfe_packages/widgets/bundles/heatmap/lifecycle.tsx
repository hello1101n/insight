import { Heatmap } from '../../src/heatmap/Heatmap';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `heatmap` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <Heatmap payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
