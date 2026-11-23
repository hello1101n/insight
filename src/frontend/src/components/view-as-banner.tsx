import { UserRoundSearch } from "lucide-react";
import { useTranslation } from "react-i18next";

import { signIn, useAuth } from "@/auth";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
} from "@gears-frontx/ui-kit";

export function ViewAsBanner(): React.ReactElement | null {
  const { t } = useTranslation();
  const { session } = useAuth();

  if (!session?.impersonatorEmail) return null;

  return (
    <Alert>
      <UserRoundSearch />
      <AlertTitle>
        {t("view_as_banner.title", { email: session.email })}
      </AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>
          {t("view_as_banner.description", {
            impersonator: session.impersonatorEmail,
          })}
        </span>
        <Button variant="outline" size="sm" onClick={() => signIn("/")}>
          {t("view_as_banner.exit")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
