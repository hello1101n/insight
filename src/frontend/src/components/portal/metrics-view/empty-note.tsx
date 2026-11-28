export function EmptyNote({ text }: { text: string }) {
  return (
    <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
      {text}
    </p>
  );
}
