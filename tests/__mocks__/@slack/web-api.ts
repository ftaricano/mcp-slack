import { jest } from '@jest/globals';

export const mockWebClient = {
  apiCall: jest.fn(),
  auth: { test: jest.fn() },
  chat: {
    postMessage: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    scheduleMessage: jest.fn(),
  },
  conversations: {
    list: jest.fn(),
    info: jest.fn(),
    history: jest.fn(),
    members: jest.fn(),
    create: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    archive: jest.fn(),
    unarchive: jest.fn(),
    rename: jest.fn(),
    invite: jest.fn(),
    kick: jest.fn(),
    setTopic: jest.fn(),
    setPurpose: jest.fn(),
  },
  users: {
    list: jest.fn(),
    info: jest.fn(),
    getPresence: jest.fn(),
    setPresence: jest.fn(),
    profile: { get: jest.fn(), set: jest.fn() },
    lookupByEmail: jest.fn(),
    conversations: jest.fn(),
  },
  reactions: { add: jest.fn(), remove: jest.fn() },
  pins: { add: jest.fn(), remove: jest.fn(), list: jest.fn() },
  files: {
    upload: jest.fn(),
    delete: jest.fn(),
    info: jest.fn(),
    list: jest.fn(),
    sharedPublicURL: jest.fn(),
    revokePublicURL: jest.fn(),
    comments: { add: jest.fn() },
  },
  team: { info: jest.fn() },
  usergroups: { list: jest.fn() },
};

export const WebClient = jest.fn().mockImplementation(() => mockWebClient);

export const LogLevel = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;
