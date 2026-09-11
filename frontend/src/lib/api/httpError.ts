import type { ValidationIssue } from "@kaigara/shared-types";

/**
 * A rejected backend request, carrying the validator's per-path issues when there are any.
 *
 * The issues are the point: a document the orchestrator refuses is almost always refused for a
 * reason that names a value ("tracks/2/loads/0/durationSeconds"), and showing that instead of
 * "422 Unprocessable Entity" is the difference between a fixable error and a mysterious one.
 *
 * Subclassed per API slice so a caller can tell a run failure from a scenario failure with
 * `instanceof`, but the parsing is shared — the backend answers every route the same way.
 */
export class ApiRequestError extends Error {
  readonly issues: ValidationIssue[];
  readonly status: number;

  constructor(message: string, status: number, issues: ValidationIssue[] = []) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.issues = issues;
  }
}

/** Builds the error for a non-OK response, reading `{ error, issues }` out of its body when it has
 *  one. A non-JSON body (a proxy's HTML 502, say) leaves the status line as the message. */
export async function requestFailure<E extends ApiRequestError>(
  response: Response,
  create: (message: string, status: number, issues: ValidationIssue[]) => E,
): Promise<E> {
  let message = `${response.status} ${response.statusText}`;
  let issues: ValidationIssue[] = [];
  try {
    const body = await response.json();
    if (typeof body?.error === "string") message = body.error;
    if (Array.isArray(body?.issues)) issues = body.issues;
  } catch {
    // Body wasn't JSON — keep the status line.
  }
  return create(message, response.status, issues);
}

/** Throws {@link requestFailure} unless the response is OK; returns its parsed JSON body. */
export async function readJsonOrThrow<T, E extends ApiRequestError>(
  response: Response,
  create: (message: string, status: number, issues: ValidationIssue[]) => E,
): Promise<T> {
  if (!response.ok) throw await requestFailure(response, create);
  return (await response.json()) as T;
}
