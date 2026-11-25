export function activatesRow(event: React.MouseEvent<HTMLElement>): boolean {
  if (event.target instanceof Element && event.target.closest("button, a")) {
    return false;
  }
  const selection = window.getSelection();
  return !selection || selection.isCollapsed;
}

export function activatesRowByKey(
  event: React.KeyboardEvent<HTMLElement>,
): boolean {
  if (event.key !== "Enter" && event.key !== " ") return false;
  return event.target === event.currentTarget;
}
