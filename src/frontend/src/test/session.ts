import type { Session } from "@/auth";

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    personId: "p-1",
    email: "bob.park@example.com",
    tenantId: "t-1",
    roles: ["user"],
    csrfToken: "csrf-1",
    expiresAt: 4102444800,
    refreshAt: 4102444710,
    experimentsEnabled: false,
    impersonatorEmail: null,
    ...overrides,
  };
}
