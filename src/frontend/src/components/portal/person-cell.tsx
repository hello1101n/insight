import { useTranslation } from "react-i18next";

import type { PersonSummary } from "@/api/identity-client";
import { CopyValueButton } from "@/components/copy-value-button";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@gears-frontx/ui-kit";
import { personDisplayName } from "@/lib/identities/person-display";
import { getInitials } from "@/lib/insight/get-initials";
import { cn } from "@/lib/utils";

const TERMINATED = "terminated";

export function PersonCell({
  person,
  className,
}: {
  person: PersonSummary;
  className?: string;
}) {
  const { t } = useTranslation();
  const resolved = personDisplayName(person);
  const named = resolved !== person.person_id;
  const name = named ? resolved : t("identities.person.unnamed");
  const detail = [person.email, person.username, person.job_title]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s) && s !== name)
    .join(" · ");

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <Avatar>
        <AvatarFallback>{named ? getInitials(resolved) : "?"}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-sm font-medium",
              named || "text-muted-foreground italic",
            )}
          >
            {name}
          </span>
          <PersonMarks person={person} />
        </div>
        {detail ? (
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        ) : null}
        <div className="flex items-center gap-1">
          <span className="truncate font-mono text-xs text-muted-foreground select-text">
            {person.person_id}
          </span>
          <CopyValueButton
            value={person.person_id}
            title={t("identities.person.copy_id")}
            copyLabel={t("common.copy")}
            copiedLabel={t("common.copied")}
            errorMessage={t("common.copy_failed")}
          />
        </div>
      </div>
    </div>
  );
}

export function PersonMarks({ person }: { person: PersonSummary }) {
  const { t } = useTranslation();
  return (
    <>
      {person.provisional ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="outline"
                className="cursor-help"
                tabIndex={0}
              />
            }
          >
            {t("identities.person.provisional")}
          </TooltipTrigger>
          <TooltipContent side="top">
            {t("identities.person.provisional_hint")}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {person.status?.trim().toLowerCase() === TERMINATED ? (
        <Badge variant="secondary">
          {t("identities.person.terminated")}
        </Badge>
      ) : null}
    </>
  );
}
