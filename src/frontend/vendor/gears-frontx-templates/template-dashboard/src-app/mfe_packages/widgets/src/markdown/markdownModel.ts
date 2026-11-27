import MarkdownIt from 'markdown-it';

/*
 * The `markdown_card` renderer: markdown-it with raw HTML off, and the link and image safety of
 * cpt-frontx-dashboard-algo-widget-catalog-markdown applied where markdown-it builds its HTML - the
 * renderer rules, never a replacement on the finished markup.
 */

/** A link may be active for these schemes only; a target with no scheme is relative and may be active too. */
const LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * A text with its leading and trailing C0 controls and spaces (U+0000 to U+0020) trimmed, as the browser URL parser
 * trims a target. An index loop: a trim regex retries its run at every inner position, quadratic on a long inner run.
 * The card links keep their own copy in `links.tsx`, so this bundle takes no kit code for six lines.
 */
function trimControlsAndSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

/** Character references decoded, as the HTML parser of an attribute decodes them; markdown-it's own decoder, no DOM. */
const decodeCharacterReferences = (text: string): string => md.utils.unescapeAll(text);

/** One percent-decoding round, lenient: markdown-it writes bytes that are not plain text back as %XX. */
function percentDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * A link or image target, read the way the browser URL parser reads it
 * (cpt-frontx-dashboard-algo-widget-catalog-markdown): character references decoded, every tab, line
 * feed and carriage return removed anywhere, leading and trailing control characters and spaces
 * trimmed; the scheme is the text before the first `:` when that text starts with a letter and holds
 * only letters, digits, `+`, `-` and `.`, compared case-insensitively; a target with no scheme is
 * relative. The percent round stands in for the encoding markdown-it already applied to the
 * destination: `java&#9;script:` reaches a rule as `java%09script:`, and the browser reads both as
 * the `javascript` scheme.
 */
export function readTarget(raw: string): { scheme: string | null; url: URL | null } {
  const text = trimControlsAndSpaces(percentDecode(decodeCharacterReferences(raw)).replace(/[\t\n\r]/g, ''));
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase() ?? null;
  let url: URL | null = null;
  try {
    url = new URL(text, document.baseURI);
  } catch {
    url = null;
  }
  return { scheme, url };
}

/** Whether a link may be active: a relative target, or the `http`, `https` or `mailto` scheme. */
export function isLinkActive(raw: string): boolean {
  const { scheme } = readTarget(raw);
  return scheme === null || LINK_SCHEMES.has(scheme);
}

/**
 * Whether an image may load: a relative target only, resolving against the document base URL, as
 * `src` does, to the page origin. Every target with a scheme is blocked, and so is a relative one
 * that resolves to another origin, such as `//other.example/a.png` or any target under a `<base>`
 * element that names another origin.
 */
export function isSameOriginImage(raw: string): boolean {
  const { scheme, url } = readTarget(raw);
  if (scheme !== null || url === null || url.origin !== location.origin) return false;
  // The browser resolves the string as it lands in `src`, not its decoded form: `//a.example%2F@b.example/x` reads as
  // a path here once decoded, but loads from b.example. The undecoded string must resolve to the page origin too.
  try {
    const loaded = new URL(raw, document.baseURI);
    return loaded.origin === location.origin && loaded.username === '' && loaded.password === '';
  } catch {
    return false;
  }
}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// The decision below is the widget's, so markdown-it's own scheme guard must not turn a target it
// dislikes into its literal-text fallback, which would show `[click](javascript:...)` instead of the
// link text alone. Every target still passes the rules here before any link or image is drawn.
md.validateLink = () => true;

const linkOpenDefault = md.renderer.rules.link_open;
const imageDefault = md.renderer.rules.image;

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  // An inactive link shows its link text as plain text: it opens nothing, so it draws no element.
  if (!isLinkActive(String(tokens[idx].attrGet('href') ?? ''))) return '';
  const token = tokens[idx];
  // Every active link opens in a new browsing context, with no access to the opener.
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return linkOpenDefault ? linkOpenDefault(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_close = (tokens, idx) => {
  // Links do not nest, so the matching open is the one that balances the depth back to zero.
  let depth = 0;
  for (let index = idx; index >= 0; index -= 1) {
    const type = tokens[index].type;
    if (type === 'link_close') depth += 1;
    else if (type === 'link_open') {
      depth -= 1;
      if (depth === 0) return isLinkActive(String(tokens[index].attrGet('href') ?? '')) ? '</a>' : '';
    }
  }
  return '</a>';
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (isSameOriginImage(String(token.attrGet('src') ?? ''))) {
    return imageDefault ? imageDefault(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  }
  // Not loadable: its alt text as text, or nothing when it has none.
  const alt = md.renderer.renderInlineAsText(token.children ?? [], options, env);
  return md.utils.escapeHtml(alt);
};

/** The body as HTML, with the safety rules already applied in the renderer rules above. */
export function renderMarkdown(body: string): string {
  return md.render(body);
}
