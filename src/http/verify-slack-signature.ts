import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

/**
 * Express middleware that verifies the `X-Slack-Signature` header against the
 * raw request body, per https://api.slack.com/authentication/verifying-requests-from-slack.
 *
 * Mount BEFORE any JSON body parser so `req.body` is the raw Buffer (or string)
 * Slack signed. If the route already parsed JSON, use the `getRawBody` option.
 *
 * Rejects with 401 when:
 *  - X-Slack-Request-Timestamp or X-Slack-Signature header is missing
 *  - timestamp is more than `maxAgeSec` seconds away from now (default 300)
 *  - the computed HMAC does not constant-time match the provided signature
 */
export interface VerifySlackSignatureOptions {
  maxAgeSec?: number;
  getRawBody?: (req: Request) => string | Buffer;
}

export function verifySlackSignature(
  signingSecret: string,
  options: VerifySlackSignatureOptions = {},
) {
  if (!signingSecret) {
    throw new Error('verifySlackSignature: signingSecret is required');
  }
  const maxAgeSec = options.maxAgeSec ?? 300;
  const getRawBody =
    options.getRawBody ??
    ((req: Request): string | Buffer => {
      if (req.body instanceof Buffer) return req.body;
      if (typeof req.body === 'string') return req.body;
      // Last-ditch: stringify whatever the JSON parser left us. This is lossy
      // (key order, whitespace) and will only verify if Slack happens to use
      // the same canonical form. Prefer mounting before json parser.
      return JSON.stringify(req.body ?? {});
    });

  return (req: Request, res: Response, next: NextFunction) => {
    const ts = req.header('X-Slack-Request-Timestamp');
    const sig = req.header('X-Slack-Signature');
    if (!ts || !sig) {
      return res.status(401).json({ error: 'missing slack signature headers' });
    }
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return res.status(401).json({ error: 'invalid timestamp' });
    }
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (ageSec > maxAgeSec) {
      return res.status(401).json({ error: 'stale request' });
    }
    const raw = getRawBody(req);
    const rawStr = raw instanceof Buffer ? raw.toString('utf8') : raw;
    const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${ts}:${rawStr}`).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    return next();
  };
}
