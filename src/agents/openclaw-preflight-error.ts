const OPENCLAW_PREFLIGHT_ERROR_CODE = "openclaw_preflight_denied";

export class OpenClawPreflightError extends Error {
  readonly code = OPENCLAW_PREFLIGHT_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "OpenClawPreflightError";
  }
}

export function isOpenClawPreflightError(error: unknown): error is OpenClawPreflightError {
  return (
    error instanceof Error &&
    ((error as { code?: string }).code === OPENCLAW_PREFLIGHT_ERROR_CODE ||
      error.name === "OpenClawPreflightError")
  );
}
