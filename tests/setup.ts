import { jest } from '@jest/globals';

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  process.env.OAUTH_STATE_SECRET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  process.env.SLACK_CLIENT_ID = 'test-client-id';
  process.env.SLACK_CLIENT_SECRET = 'test-client-secret';
  process.env.LOG_LEVEL = 'silent';
});

afterEach(() => {
  jest.clearAllTimers();
});
