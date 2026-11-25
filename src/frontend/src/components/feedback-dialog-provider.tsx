import { useMemo, useState, type ReactNode } from "react";

import { FeedbackDialogContext } from "@/components/feedback-context";
import { FeedbackDialog } from "@/components/feedback-dialog";

export function FeedbackDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ openFeedback: () => setOpen(true) }), []);

  return (
    <FeedbackDialogContext.Provider value={value}>
      {children}
      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </FeedbackDialogContext.Provider>
  );
}
