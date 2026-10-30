/** Errors that map to client-facing HTTP status codes. */
export class NotFoundError extends Error {
  readonly statusCode = 404;
}

export class ConflictError extends Error {
  readonly statusCode = 409;
}

export class ValidationError extends Error {
  readonly statusCode = 400;
}
