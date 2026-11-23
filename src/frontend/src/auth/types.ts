export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export type Session = {
  personId: string;
  email: string;
  tenantId: string;
  roles: string[];
  csrfToken: string;
  expiresAt: number;
  refreshAt: number;
  experimentsEnabled: boolean;
  impersonatorEmail: string | null;
};

export type AuthSnapshot = {
  status: AuthStatus;
  session: Session | null;
};
