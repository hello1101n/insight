import { GridWidget } from '../../src/grid/GridWidget';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `grid` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <GridWidget payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
