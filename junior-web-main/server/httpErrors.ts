export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
  }
}

export class AuthenticationError extends HttpError {
  constructor(message = 'Authentication is required.') {
    super(message, 401, 'authentication_required');
  }
}

export class AuthorizationError extends HttpError {
  constructor(message = 'You do not have permission to perform this action.') {
    super(message, 403, 'forbidden');
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'The requested resource was not found.') {
    super(message, 404, 'not_found');
  }
}