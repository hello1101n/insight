import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@gears-frontx/ui-kit";

import type { PersonSummary } from "@/api/identity-client";
import type { CreatedSqlToken, SqlTokenEntry } from "@/api/sql-tokens-client";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PersonPicker } from "@/components/portal/person-picker";
import { PersonName } from "@/components/portal/usage-table";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { personDisplayName } from "@/lib/identities/person-display";
import { formatUtcClock } from "@/lib/format";
import { TEXT_NAME } from "@/lib/type-scale";
import {
  useCreateSqlToken,
  useRemoveSqlToken,
  useSqlTokens,
} from "@/queries/sql-tokens";

const LABEL_MAX_CHARS = 255;

const LIFETIMES = [
  { days: 30, label: "sql_tokens.create.lifetime_30" },
  { days: 90, label: "sql_tokens.create.lifetime_90" },
  { days: 365, label: "sql_tokens.create.lifetime_365" },
  { days: 730, label: "sql_tokens.create.lifetime_730" },
] as const;

const DEFAULT_LIFETIME_DAYS = 365;

export function SqlTokensView() {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className={TEXT_NAME}>{t("sql_tokens.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("sql_tokens.subtitle")}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          {t("sql_tokens.create_token")}
        </Button>
      </div>
      <TokenList />
      {creating ? (
        <CreateTokenDialog onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

function TokenList() {
  const { t } = useTranslation();
  const tokens = useSqlTokens();
  const [removing, setRemoving] = useState<SqlTokenEntry | null>(null);

  if (tokens.isPending) return <CenteredSpinner />;
  if (tokens.isError) {
    return (
      <ComingSoon
        variant="row"
        state="error"
        label={t("sql_tokens.list.load_failed")}
      />
    );
  }
  if (tokens.data.items.length === 0) {
    return (
      <ComingSoon
        variant="row"
        state="empty"
        label={t("sql_tokens.list.empty")}
      />
    );
  }

  return (
    <>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-2 font-medium">{t("sql_tokens.list.person")}</th>
            <th className="py-2 font-medium">{t("sql_tokens.list.label")}</th>
            <th className="py-2 font-medium">{t("sql_tokens.list.created")}</th>
            <th className="py-2 font-medium">{t("sql_tokens.list.expires")}</th>
            <th className="py-2 font-medium">
              {t("sql_tokens.list.created_by")}
            </th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {tokens.data.items.map((entry) => (
            <tr key={entry.token_id} className="border-t">
              <td className="py-2">
                <PersonName row={entry.person} />
              </td>
              <td className="py-2">{entry.label}</td>
              <td className="py-2">
                {formatUtcClock(entry.created_at, "d MMM yyyy")}
              </td>
              <td className="py-2">
                {formatUtcClock(entry.expires_at, "d MMM yyyy")}
              </td>
              <td className="py-2">
                <PersonName row={entry.created_by} />
              </td>
              <td className="py-2 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("sql_tokens.list.remove_named", {
                    label: entry.label,
                  })}
                  onClick={() => setRemoving(entry)}
                >
                  {t("sql_tokens.list.remove")}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {removing ? (
        <RemoveTokenDialog entry={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </>
  );
}

function RemoveTokenDialog({
  entry,
  onClose,
}: {
  entry: SqlTokenEntry;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useRemoveSqlToken();

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("sql_tokens.remove.title", { label: entry.label })}
      description={t("sql_tokens.remove.description", {
        person: personDisplayName(entry.person),
      })}
      confirmLabel={t("sql_tokens.remove.confirm")}
      destructive
      isPending={remove.isPending}
      error={remove.isError ? t("sql_tokens.remove.failed") : null}
      onConfirm={() => remove.mutate(entry.token_id, { onSuccess: onClose })}
    />
  );
}

function CreateTokenDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreateSqlToken();
  const [person, setPerson] = useState<PersonSummary | null>(null);
  const [label, setLabel] = useState("");
  const [lifetimeDays, setLifetimeDays] = useState(DEFAULT_LIFETIME_DAYS);
  const lifetime = LIFETIMES.find((option) => option.days === lifetimeDays);

  const closable = !create.isPending && create.data === undefined;
  const requestClose = (open: boolean) => {
    if (!open && closable) onClose();
  };
  const ready = person !== null && label.trim() !== "" && !create.isPending;

  return (
    <Dialog open onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-lg" showCloseButton={closable}>
        <DialogHeader>
          <DialogTitle>{t("sql_tokens.create.title")}</DialogTitle>
          <DialogDescription>
            {t("sql_tokens.create.description")}
          </DialogDescription>
        </DialogHeader>
        {create.data ? (
          <ShownToken created={create.data} />
        ) : (
          <div className="flex flex-col gap-3">
            {person ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>{personDisplayName(person)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPerson(null)}
                >
                  {t("sql_tokens.create.change_person")}
                </Button>
              </div>
            ) : (
              <PersonPicker onPick={setPerson} />
            )}
            <label
              className="flex flex-col gap-1 text-sm"
              htmlFor="sql-token-label"
            >
              {t("sql_tokens.create.label")}
              <Input
                id="sql-token-label"
                value={label}
                maxLength={LABEL_MAX_CHARS}
                placeholder={t("sql_tokens.create.label_placeholder")}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor="sql-token-lifetime">
                {t("sql_tokens.create.lifetime")}
              </label>
              <Select
                value={String(lifetimeDays)}
                onValueChange={(next) => {
                  if (typeof next === "string") setLifetimeDays(Number(next));
                }}
              >
                <SelectTrigger id="sql-token-lifetime" className="w-full">
                  <SelectValue>
                    {lifetime ? t(lifetime.label) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  {LIFETIMES.map((option) => (
                    <SelectItem key={option.days} value={String(option.days)}>
                      {t(option.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {create.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {t("sql_tokens.create.failed")}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {create.data ? (
            <Button onClick={onClose}>{t("sql_tokens.create.done")}</Button>
          ) : (
            <Button
              disabled={!ready}
              onClick={() => {
                if (person === null) return;
                create.mutate({
                  person_id: person.person_id,
                  label: label.trim(),
                  lifetime_days: lifetimeDays,
                });
              }}
            >
              {t("sql_tokens.create.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShownToken({ created }: { created: CreatedSqlToken }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex gap-2">
        <Input
          readOnly
          aria-label={t("sql_tokens.shown.token")}
          value={created.token}
          className="font-mono"
        />
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              .writeText(created.token)
              .then(() => setCopied(true));
          }}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
      </div>
      <p className="text-muted-foreground">{t("sql_tokens.shown.once")}</p>
    </div>
  );
}
