import type { ReactNode } from "react";

export function ChatProse({ text }: { text: string }) {
  return <>{text.split(BOLD).map(toSegment)}</>;
}

const BOLD = /\*\*([^*]+)\*\*/g;

function toSegment(part: string, index: number): ReactNode {
  return index % 2 === 1 ? <strong key={index}>{part}</strong> : part;
}
