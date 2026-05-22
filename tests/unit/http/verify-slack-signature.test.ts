import crypto from 'node:crypto';

import express from 'express';
import request from 'supertest';

import { verifySlackSignature } from '../../../src/http/verify-slack-signature.js';

const SECRET = 'test-signing-secret';
function sign(body: string, ts: string, secret = SECRET): string {
  return `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function buildApp() {
  const app = express();
  app.use(express.raw({ type: 'application/json' }));
  app.use(verifySlackSignature(SECRET));
  app.post('/x', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('verifySlackSignature', () => {
  it('throws when constructed without a signing secret', () => {
    expect(() => verifySlackSignature('')).toThrow();
  });

  it('accepts a request with a valid signature', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ a: 1 });
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('X-Slack-Signature', sign(body, ts))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects when X-Slack-Signature is missing', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing/);
  });

  it('rejects when X-Slack-Request-Timestamp is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Signature', 'v0=deadbeef')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(401);
  });

  it('rejects when timestamp is non-numeric', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', 'not-a-number')
      .set('X-Slack-Signature', 'v0=00')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(401);
  });

  it('rejects when timestamp is older than 5 minutes', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const body = '{}';
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('X-Slack-Signature', sign(body, ts))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/stale/);
  });

  it('rejects when timestamp is too far in the future', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000) + 600);
    const body = '{}';
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('X-Slack-Signature', sign(body, ts))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('rejects an invalid signature', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('X-Slack-Signature', 'v0=' + 'a'.repeat(64))
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/);
  });

  it('rejects a signature signed with a different secret', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ a: 1 });
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('X-Slack-Signature', sign(body, ts, 'WRONG-SECRET'))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('honors a custom maxAgeSec window', async () => {
    const app = express();
    app.use(express.raw({ type: 'application/json' }));
    app.use(verifySlackSignature(SECRET, { maxAgeSec: 30 }));
    app.post('/x', (_req, res) => res.json({ ok: true }));

    const ts = String(Math.floor(Date.now() / 1000) - 60);
    const body = '{}';
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('X-Slack-Signature', sign(body, ts))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('uses constant-time comparison (lengths differ -> reject)', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{}';
    const res = await request(app)
      .post('/x')
      .set('X-Slack-Request-Timestamp', ts)
      .set('X-Slack-Signature', 'v0=short')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });
});
