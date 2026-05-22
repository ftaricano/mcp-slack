import crypto from 'node:crypto';

import winston from 'winston';

import { AuditLogEntry } from '../types/mcp.js';

const logLevel = process.env.LOG_LEVEL || 'info';
const auditLogPath = process.env.AUDIT_LOG_PATH || './logs/audit.log';

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bxox[baprs]-[A-Za-z0-9-]+\b/g, 'xox<REDACTED>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, 'Bearer <REDACTED>'],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, 'gh<REDACTED>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA<REDACTED>'],
  [
    /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g,
    '<REDACTED_PRIVATE_KEY>',
  ],
];

const SENSITIVE_KEY_RE =
  /(^|[_-])(token|secret|password|passwd|pwd|authorization|cookie|state|state[_-]?secret|code[_-]?verifier|authorization[_-]?code|oauth[_-]?code|api[_-]?key|client[_-]?secret|signing[_-]?secret|jwt[_-]?secret|access[_-]?token|refresh[_-]?token|bot[_-]?token|user[_-]?token)([_-]|$)/i;

const CONTENT_KEY_RE = /^(text|content|initial_comment|blocks|attachments|file)$/i;

function summarize(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const hash = crypto
    .createHash('sha256')
    .update(raw ?? '')
    .digest('hex')
    .slice(0, 12);
  return `[REDACTED length=${raw?.length ?? 0} sha256=${hash}]`;
}

function redactString(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  redacted = redacted.replace(
    /([?&](?:code|state|token|client_secret|access_token|refresh_token|secret)=)[^&\s]+/gi,
    '$1<REDACTED>',
  );
  return redacted;
}

export function redactForLogging(
  value: unknown,
  keyHint = '',
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') {
    return CONTENT_KEY_RE.test(keyHint) ? summarize(value) : redactString(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[REDACTED buffer length=${value.length}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return CONTENT_KEY_RE.test(keyHint)
      ? summarize(value)
      : value.map((item) => redactForLogging(item, keyHint, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = '[REDACTED]';
    } else if (CONTENT_KEY_RE.test(key)) {
      result[key] = summarize(nested);
    } else {
      result[key] = redactForLogging(nested, key, seen);
    }
  }
  return result;
}

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    info[key] = redactForLogging(info[key], key);
  }
  return info;
});

// Main application logger
export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'mcp-slack' },
  transports: [
    new winston.transports.File({
      filename: './logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: './logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 10,
    }),
  ],
});

// Console transport for development
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  );
}

// Audit logger for compliance
export const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(redactFormat(), winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({
      filename: auditLogPath,
      maxsize: 10485760, // 10MB
      maxFiles: 20,
    }),
  ],
});

// Audit log helper function
export function logAudit(entry: Omit<AuditLogEntry, 'timestamp'>): void {
  const auditEntry: AuditLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  auditLogger.info('AUDIT', auditEntry);

  // Also log to main logger for debugging
  logger.info('Audit log entry', { audit: auditEntry });
}

// Error logging with context
export function logError(error: Error, context: Record<string, any> = {}): void {
  logger.error('Error occurred', {
    message: error.message,
    stack: error.stack,
    context,
  });
}

// Performance logging
export function logPerformance(
  operation: string,
  duration: number,
  context: Record<string, any> = {},
): void {
  logger.info('Performance metric', {
    operation,
    duration,
    context,
  });
}

// Request logging middleware helper
export function createRequestLogger() {
  return (req: any, res: any, next: any) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info('HTTP Request', {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
      });
    });

    next();
  };
}

export default logger;
