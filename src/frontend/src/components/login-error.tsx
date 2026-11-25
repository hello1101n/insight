import { useTranslation } from "react-i18next";

import { clearAuthErrorAttempts, signIn } from "@/auth";
import { Button, Card, CardContent } from "@gears-frontx/ui-kit";

type LoginErrorProps = {
  code: string;
};

export function LoginError({ code }: LoginErrorProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-svh w-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-sm font-medium">{t("auth.loginFailedTitle")}</h1>
          <p className="text-sm text-muted-foreground" role="alert">
            {code === "access_denied"
              ? t("auth.loginFailedAccessDenied")
              : t("auth.loginFailedRetryable")}
          </p>
          <Button
            onClick={() => {
              clearAuthErrorAttempts();
              signIn();
            }}
          >
            {t("auth.loginFailedTryAgain")}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
