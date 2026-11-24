import { useRef, useState } from "react";

import type { AttentionItem, PersonSummary } from "@/api/identity-client";
import { AccountDetail } from "@/components/portal/account-detail";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@gears-frontx/ui-kit";
import { itemKey, parseAccountKey } from "@/lib/identities/account-key";
import { nextInWalk } from "@/lib/identities/walk";
import { useTranslation } from "react-i18next";

export interface CaseRow extends AttentionItem {
  holder?: PersonSummary | null;
}

interface HeldCase {
  acct?: string;
  item?: CaseRow;
  walk?: readonly string[];
}

export function CaseDialog({
  acct,
  items,
  walk,
  onNavigate,
  onClose,
}: {
  acct: string | undefined;
  items: CaseRow[];
  walk?: readonly string[];
  onNavigate?: (key: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const popupRef = useRef<HTMLDivElement>(null);
  const ref = parseAccountKey(acct);

  const live = items.find((i) => itemKey(i) === acct);

  const [held, setHeld] = useState<HeldCase>({});

  const heldWalk =
    acct != null && held.acct === acct && held.walk?.includes(acct)
      ? held.walk
      : walk;
  const fresh: HeldCase = {
    acct,
    item: live ?? (held.acct === acct ? held.item : undefined),
    walk: heldWalk,
  };
  if (
    held.acct !== fresh.acct ||
    held.item !== fresh.item ||
    held.walk !== fresh.walk
  ) {
    setHeld(fresh);
  }
  const queueItem = fresh.item;
  const inWalk = acct != null && fresh.walk?.includes(acct) === true;
  const next = acct != null && fresh.walk ? nextInWalk(fresh.walk, acct) : null;
  const decided = () => {
    if (next != null && onNavigate) onNavigate(next);
    else onClose();
  };

  const heading =
    queueItem?.email?.trim() ||
    queueItem?.username?.trim() ||
    queueItem?.display_name?.trim() ||
    ref?.account_id;
  const observed = queueItem != null;

  return (
    <Dialog
      open={ref != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={popupRef}
        className="flex h-[85vh] flex-col gap-4 sm:max-w-3xl"
        tabIndex={-1}
        initialFocus={popupRef}
      >
        <DialogHeader>
          <DialogTitle className="truncate select-text">{heading}</DialogTitle>
          <DialogDescription
            render={<div className="flex items-center gap-1" />}
          >
            <span className="truncate font-mono text-xs select-text">
              {ref?.source} · {ref?.account_id}
            </span>
          </DialogDescription>
        </DialogHeader>
        {ref ? (
          <AccountDetail
            key={acct}
            accountRef={ref}
            queueItem={queueItem}
            observed={observed}
            holder={queueItem?.holder ?? null}
            onDecided={decided}
          />
        ) : null}
        {inWalk && onNavigate ? (
          <div className="flex shrink-0 justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={next == null}
              onClick={() => next != null && onNavigate(next)}
            >
              {t("identities.actions.skip")}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
