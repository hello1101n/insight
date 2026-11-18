import { useState } from "react";
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
import { useCreateSqlToken, useRemoveSqlToken, useSqlTokens } from "@/queries/sql-tokens";

export function SqlTokensView() {
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className={TEXT_NAME}>SQL API tokens</h2>
          <p className="text-sm text-muted-foreground">
            Personal tokens for the SQL API. A token opens the SQL API only and works until it is
            removed.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Create token</Button>
      </div>
      <TokenList />
      {creating ? <CreateTokenDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function TokenList() {
  const tokens = useSqlTokens();
  const [removing, setRemoving] = useState<SqlTokenEntry | null>(null);

  if (tokens.isPending) return <CenteredSpinner />;
  if (tokens.isError) {
    return <ComingSoon variant="row" state="error" label="Tokens could not be loaded" />;
  }
  if (tokens.data.items.length === 0) {
    return <ComingSoon variant="row" state="empty" label="No personal tokens yet" />;
  }

  return (
    <>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-2 font-medium">Person</th>
            <th className="py-2 font-medium">Label</th>
            <th className="py-2 font-medium">Created</th>
            <th className="py-2 font-medium">Created by</th>
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
              <td className="py-2">{formatUtcClock(entry.created_at, "d MMM yyyy")}</td>
              <td className="py-2">
                <PersonName row={entry.created_by} />
              </td>
              <td className="py-2 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${entry.label}`}
                  onClick={() => setRemoving(entry)}
                >
                  Remove
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

function RemoveTokenDialog({ entry, onClose }: { entry: SqlTokenEntry; onClose: () => void }) {
  const remove = useRemoveSqlToken();

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Remove ${entry.label}?`}
      description={`${personDisplayName(entry.person)} loses SQL API access with this token. The next query with it is refused.`}
      confirmLabel="Remove"
      destructive
      isPending={remove.isPending}
      error={remove.isError ? "The token could not be removed" : null}
      onConfirm={() => remove.mutate(entry.token_id, { onSuccess: onClose })}
    />
  );
}

function CreateTokenDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateSqlToken();
  const [person, setPerson] = useState<PersonSummary | null>(null);
  const [label, setLabel] = useState("");

  const closable = !create.isPending && create.data === undefined;
  const requestClose = (open: boolean) => {
    if (!open && closable) onClose();
  };
  const ready = person !== null && label.trim() !== "" && !create.isPending;

  return (
    <Dialog open onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-lg" showCloseButton={closable}>
        <DialogHeader>
          <DialogTitle>Create a SQL API token</DialogTitle>
          <DialogDescription>
            The token is shown once. Send it to the person; it works until removed.
          </DialogDescription>
        </DialogHeader>
        {create.data ? (
          <ShownToken created={create.data} />
        ) : (
          <div className="flex flex-col gap-3">
            {person ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>{personDisplayName(person)}</span>
                <Button variant="ghost" size="sm" onClick={() => setPerson(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <PersonPicker onPick={setPerson} />
            )}
            <label className="flex flex-col gap-1 text-sm" htmlFor="sql-token-label">
              Label
              <Input
                id="sql-token-label"
                value={label}
                maxLength={255}
                placeholder="laptop, CI job, …"
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            {create.isError ? (
              <Alert variant="destructive">
                <AlertDescription>The token could not be created</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {create.data ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <Button
              disabled={!ready}
              onClick={() => {
                if (person === null) return;
                create.mutate({ person_id: person.person_id, label: label.trim() });
              }}
            >
              Create
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShownToken({ created }: { created: CreatedSqlToken }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex gap-2">
        <Input readOnly aria-label="Token" value={created.token} className="font-mono" />
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(created.token).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-muted-foreground">Copy it now. It is not shown again.</p>
    </div>
  );
}
