export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, code = 'bad_request') {
    super(message, 400, code);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'The requested resource was not found.') {
    super(message, 404, 'not_found');
  }
}

export class PathBoundaryError extends HttpError {
  constructor(message = 'The requested path escapes the configured project root.') {
    super(message, 400, 'path_outside_project');
  }
}

export class UnsupportedFileError extends HttpError {
  constructor(message: string, code = 'unsupported_file') {
    super(message, 415, code);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, code = 'conflict') {
    super(message, 409, code);
  }
}

export class StorageUnavailableError extends HttpError {
  constructor(message = 'The configured storage backend is unavailable.') {
    super(message, 503, 'storage_unavailable');
  }
}

/** An agent-run failure whose message is credential-safe and actionable for the user. */
export class AgentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export class AuthenticationError extends HttpError {
  constructor(message = 'Sign in with Microsoft Entra to use AAA.', code = 'auth_required') {
    super(message, 401, code);
  }
}

export class AuthorizationError extends HttpError {
  constructor(message = 'Your account does not have access to AAA.', code = 'forbidden') {
    super(message, 403, code);
  }
}
