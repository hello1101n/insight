import { Badge } from '@gears-frontx/ui-kit';

import { hasVisibleText } from './links';
import type { Tone, Tones } from './types';

/** The kit badge of each tone: neutral is the secondary badge, the others the badge of their own name. */
const BADGE: Record<Tone, 'secondary' | 'success' | 'warning' | 'danger' | 'info'> = { neutral: 'secondary', success: 'success', warning: 'warning', danger: 'danger', info: 'info' };

/** The tone of a status: its own in `tones`, or neutral when it has none. */
const toneOf = (status: string, tones: Tones | undefined): Tone => (tones && Object.hasOwn(tones, status) ? tones[status] : 'neutral');

/**
 * A status drawn as a badge with its text, painted by its tone (the shared tones type), so the tone never carries it
 * alone. A text with no visible character (the link rule's test) draws no badge: an empty painted badge says nothing.
 */
export function ToneBadge({ text, tones, className }: { text: string; tones: Tones | undefined; className?: string }) {
  if (!hasVisibleText(text)) return null;
  return (
    <Badge variant={BADGE[toneOf(text, tones)]} className={className}>
      {text}
    </Badge>
  );
}
