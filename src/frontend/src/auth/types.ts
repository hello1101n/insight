export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export type Session = {
  personId: string;
  email: string;
  tenantId: string;
  roles: string[];
  csrfToken: string;
  expiresAt: number | null;
  refreshAt: number | null;
  experimentsEnabled: boolean;
  impersonatorEmail: string | null;
};

export type AuthSnapshot =
  | { status: "authenticated"; session: Session }
  | { status: "loading" | "unauthenticated"; session: null };
