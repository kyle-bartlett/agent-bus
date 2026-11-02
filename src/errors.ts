/** Error carrying an HTTP status and a stable machine-readable code. */
export class BusError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BusError";
  }
}

export function asBusError(e: unknown): BusError {
  if (e instanceof BusError) return e;
  return new BusError(500, "internal_error", e instanceof Error ? e.message : String(e));
}
