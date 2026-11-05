/** Preserve the server verdict instead of treating a network outage as logout. */
export class AuthResponseError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "AuthResponseError";
  }
}

export function isAuthenticationRejected(error: unknown): boolean {
  return (
    error instanceof AuthResponseError &&
    (error.status === 401 || error.status === 403)
  );
}
