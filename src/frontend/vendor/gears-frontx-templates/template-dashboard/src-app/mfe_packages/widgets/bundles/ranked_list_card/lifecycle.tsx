import { RankedListCard } from '../../src/cards/RankedListCard';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `ranked_list_card` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <RankedListCard payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
