import { useEffect, type ReactNode } from 'react';
import { Link, VisuallyHidden } from '@gears-frontx/ui-kit';

import type { WidgetTexts } from './states';

/**
 * A text with its leading and trailing C0 controls and spaces (U+0000 to U+0020) trimmed, as the browser URL parser
 * trims a target. An index loop: a trim regex retries its run at every inner position, quadratic on a long inner run.
 */
function trimControlsAndSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

// Read a target the way the browser URL parser does: tabs and line breaks removed, leading and trailing controls and spaces trimmed.
const cleanOf = (href: string) => trimControlsAndSpaces(href.replace(/[\t\n\r]/g, ''));
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// The schemes a refused target's console line names; any other is "an unsupported scheme", so no text of the target reaches the console.
const NAMED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'ftp']);
// Two slashes, either way round, start a protocol-relative target: another host.
const PROTOCOL_RELATIVE = /^[\\/]{2}/;

/** A target a widget may link to, and whether it leaves the page's origin; or why it may not. */
export type LinkTarget = { href: string; external: boolean } | { problem: string };

/**
 * The shared rule for a widget link target (card links and grid link values): `https:`, `http:`, `mailto:`, or a path from the site root (`/...`, not `//`).
 * Any other scheme, a protocol-relative target, another relative target and an unparsable one are refused; the
 * problem names the kind of target from a fixed set, never any text of the target, which is delivered data.
 */
export function linkTargetOf(href: string, origin: string): LinkTarget {
  const cleaned = cleanOf(href);
  if (PROTOCOL_RELATIVE.test(cleaned)) return { problem: 'a protocol-relative target' };
  if (cleaned.startsWith('/')) return { href: cleaned, external: false };
  const scheme = SCHEME.exec(cleaned)?.[1]?.toLowerCase();
  if (scheme === undefined) return { problem: 'a relative target that does not start with /' };
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return { problem: NAMED_SCHEMES.has(scheme) ? `the ${scheme}: scheme` : 'an unsupported scheme' };
  try {
    const url = new URL(cleaned);
    return { href: url.href, external: scheme !== 'mailto' && url.origin !== origin };
  } catch {
    return { problem: 'an unparsable target' };
  }
}

/*
 * A character that draws on its own: not a space, not a control, not an invisible one (zero-width marks, word joiner,
 * byte order mark, soft hyphen), not a combining mark (it draws only on another character), and not one of the two
 * blank glyphs, the braille pattern blank (U+2800) and the musical null notehead (U+1D159). One character class: a linear test.
 */
const VISIBLE = /[^\s\p{Cc}\p{Default_Ignorable_Code_Point}\p{M}\u2800\u{1D159}]/u;

/** Whether a text has a visible character, so a link has a name to read and to see, and a badge has text to show. */
export const hasVisibleText = (text: string): boolean => VISIBLE.test(text);

/**
 * A widget link through the shared rule. A refused target draws the text alone and writes one console line with the
 * reason; the cell does not fail. A text with no visible character draws as text with no anchor and no console line:
 * a link needs a name. A link to another origin opens in a new tab without access to its opener, and says so.
 * `children`, when given, is drawn in place of `text` (the grid wraps the text for truncation).
 */
export function SafeLink({ text, href, texts, className, children }: { text: string; href: string; texts: WidgetTexts; className?: string; children?: ReactNode }) {
  const named = hasVisibleText(text);
  const target = linkTargetOf(href, window.location.origin);
  const problem = named && 'problem' in target ? target.problem : null;
  useEffect(() => {
    if (problem) console.warn(`[widget] a link is shown as text: ${problem}`);
  }, [problem]);
  if (!named || 'problem' in target) return <span className={className}>{children ?? text}</span>;
  return (
    <Link href={target.href} external={target.external} rel={target.external ? 'noopener noreferrer' : undefined} className={className}>
      {children ?? text}
      {target.external ? <VisuallyHidden> ({texts.link.newTab})</VisuallyHidden> : null}
    </Link>
  );
}
