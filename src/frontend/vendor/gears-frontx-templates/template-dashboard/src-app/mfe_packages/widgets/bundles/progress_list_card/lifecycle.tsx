import { ProgressListCard } from '../../src/cards/ProgressListCard';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `progress_list_card` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <ProgressListCard payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
