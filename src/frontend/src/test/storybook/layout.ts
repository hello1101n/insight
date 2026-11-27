function boxesOverlap(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

export function expectNothingOverlaps(
  subject: Element,
  elements: readonly Element[],
  describe: (element: Element) => string
): void {
  const box = subject.getBoundingClientRect();
  for (const element of elements) {
    const other = element.getBoundingClientRect();
    if (!boxesOverlap(box, other)) continue;
    throw new Error(
      `${describe(element)} is drawn over the subject: ` +
        `subject x ${box.left}–${box.right} y ${box.top}–${box.bottom}, ` +
        `other x ${other.left}–${other.right} y ${other.top}–${other.bottom}`
    );
  }
}

export function expectHorizontallyContained(
  container: Element,
  elements: readonly Element[],
  describe: (element: Element) => string
): void {
  const SLACK_PX = 1;
  const box = container.getBoundingClientRect();
  for (const element of elements) {
    const other = element.getBoundingClientRect();
    if (
      other.left >= box.left - SLACK_PX &&
      other.right <= box.right + SLACK_PX
    ) {
      continue;
    }
    throw new Error(
      `${describe(element)} spills outside its container: ` +
        `container x ${box.left}–${box.right}, ` +
        `other x ${other.left}–${other.right}`
    );
  }
}

export function expectHorizontallyCentred(
  container: Element,
  child: Element,
  describe: string
): void {
  const SLACK_PX = 0.5;
  const box = container.getBoundingClientRect();
  const inner = child.getBoundingClientRect();
  const offset = inner.left + inner.width / 2 - (box.left + box.width / 2);
  if (Math.abs(offset) < SLACK_PX) return;
  throw new Error(
    `${describe} is ${offset}px off its container's centre: ` +
      `container x ${box.left}–${box.right}, ` +
      `child x ${inner.left}–${inner.right}`
  );
}

export const CARD_PX_AT_390 = 296;

export const CARD_PX_WIDE = 900;
