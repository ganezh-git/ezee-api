import { Request, Response, NextFunction } from 'express';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  logger.error({
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url,
  });

  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
}
