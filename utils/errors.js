class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg) => new AppError(400, msg);
const notFound = (msg) => new AppError(404, msg);
const conflict = (msg) => new AppError(409, msg);
const unprocessable = (msg) => new AppError(422, msg);

// Forwards rejected promises from async route handlers to the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, badRequest, notFound, conflict, unprocessable, asyncHandler };
