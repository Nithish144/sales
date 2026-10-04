const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Route not found.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }
  // Malformed JSON body
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  // Prisma known errors
  if (err.code === 'P2002') return res.status(409).json({ error: 'Shop already exists.' });
  if (err.code === 'P2025') return res.status(404).json({ error: 'Record not found.' });
  if (err.code === 'P2003') {
    return res.status(409).json({ error: 'This record is referenced by other data and cannot be changed.' });
  }

  // Anything else: log the details on the server, send a generic message to the client (never a stack trace).
  console.error('[error]', req.method, req.originalUrl, err);
  return res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
}

module.exports = { notFoundHandler, errorHandler };
