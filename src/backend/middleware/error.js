/**
 * Centralized error handling middleware
 */

/**
 * Not Found handler
 * Catches requests to undefined routes
 */
const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  error.status = 404;
  next(error);
};

/**
 * Global error handler
 * Processes all errors and sends appropriate response
 */
const errorHandler = (err, req, res, next) => {
  // Log error for debugging
  console.error('Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    user: req.user?.username
  });

  // Determine status code
  let statusCode = err.status || err.statusCode || 500;
  
  // Handle specific error types
  if (err.name === 'ValidationError') {
    statusCode = 400;
  } else if (err.name === 'CastError') {
    statusCode = 400;
  } else if (err.code === 11000) {
    // MongoDB duplicate key error
    statusCode = 409;
  }

  // Build error response
  const response = {
    error: getErrorName(statusCode),
    message: err.message || 'An unexpected error occurred',
    ...(process.env.NODE_ENV === 'development' && {
      stack: err.stack,
      details: err.details
    })
  };

  // Handle MongoDB validation errors
  if (err.name === 'ValidationError' && err.errors) {
    response.validationErrors = Object.keys(err.errors).map(field => ({
      field,
      message: err.errors[field].message
    }));
  }

  // Handle duplicate key errors
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    response.message = `Duplicate value for field: ${field}`;
  }

  res.status(statusCode).json(response);
};

/**
 * Get error name from status code
 */
function getErrorName(statusCode) {
  const errorNames = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable'
  };

  return errorNames[statusCode] || 'Error';
}

/**
 * Async handler wrapper
 * Wraps async route handlers to catch errors
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Create custom error
 */
class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = {
  notFound,
  errorHandler,
  asyncHandler,
  AppError
};
