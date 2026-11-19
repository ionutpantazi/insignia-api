export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ConfigurationError extends Error {}

export function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

export function errorSummary(error: unknown): object {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof ConfigurationError || error instanceof HttpError ? error.message : undefined,
    code: errorCode(error),
    causeCode: error instanceof Error ? errorCode(error.cause) : undefined,
  };
}
