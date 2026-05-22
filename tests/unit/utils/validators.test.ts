import {
  SlackChannelIdSchema,
  SlackChannelNameSchema,
  SlackUserIdSchema,
  SlackTimestampSchema,
  SlackResourceUriSchema,
  PaginationSchema,
  SearchSchema,
  SlackMessageSendSchema,
  SlackChannelCreateSchema,
  OAuthStateSchema,
  AuditLogEntrySchema,
  ValidationError,
  createValidator,
  sanitizeHtml,
  sanitizeSlackMessage,
  createErrorResponse,
  validationErrorToMcpError,
} from '../../../src/utils/validators.js';

describe('SlackChannelIdSchema', () => {
  it.each(['C1234567890', 'G1234567890', 'D1234567890', 'CABC'])('accepts %s', (v) => {
    expect(SlackChannelIdSchema.parse(v)).toBe(v);
  });
  it.each(['', 'c1234567890', 'C-12345', 'general', 'C 12345'])('rejects %s', (v) => {
    expect(() => SlackChannelIdSchema.parse(v)).toThrow();
  });
});

describe('SlackChannelNameSchema', () => {
  it.each(['general', 'team-eng', 'incident_response', 'a'])('accepts %s', (v) => {
    expect(SlackChannelNameSchema.parse(v)).toBe(v);
  });
  it('rejects empty', () => {
    expect(() => SlackChannelNameSchema.parse('')).toThrow();
  });
  it('rejects > 21 chars', () => {
    expect(() => SlackChannelNameSchema.parse('a'.repeat(22))).toThrow();
  });
  it('rejects uppercase', () => {
    expect(() => SlackChannelNameSchema.parse('General')).toThrow();
  });
  it('rejects spaces', () => {
    expect(() => SlackChannelNameSchema.parse('team eng')).toThrow();
  });
});

describe('SlackUserIdSchema', () => {
  it('accepts U1234567890', () => {
    expect(SlackUserIdSchema.parse('U1234567890')).toBe('U1234567890');
  });
  it('rejects lowercase', () => {
    expect(() => SlackUserIdSchema.parse('u1234567890')).toThrow();
  });
});

describe('SlackTimestampSchema', () => {
  it('accepts canonical slack ts', () => {
    expect(SlackTimestampSchema.parse('1234567890.123456')).toBe('1234567890.123456');
  });
  it('rejects missing decimals', () => {
    expect(() => SlackTimestampSchema.parse('1234567890')).toThrow();
  });
  it('rejects wrong-precision decimals', () => {
    expect(() => SlackTimestampSchema.parse('1234567890.123')).toThrow();
  });
});

describe('SlackResourceUriSchema', () => {
  it('accepts slack://channel/C123', () => {
    expect(SlackResourceUriSchema.parse('slack://channel/C123')).toBe('slack://channel/C123');
  });
  it('rejects http://', () => {
    expect(() => SlackResourceUriSchema.parse('http://channel/C123')).toThrow();
  });
});

describe('PaginationSchema', () => {
  it('defaults limit to 100', () => {
    expect(PaginationSchema.parse({})).toEqual({ limit: 100 });
  });
  it('respects explicit limit', () => {
    expect(PaginationSchema.parse({ limit: 5 }).limit).toBe(5);
  });
  it('rejects limit < 1', () => {
    expect(() => PaginationSchema.parse({ limit: 0 })).toThrow();
  });
  it('rejects limit > 1000', () => {
    expect(() => PaginationSchema.parse({ limit: 1001 })).toThrow();
  });
});

describe('SearchSchema', () => {
  it('applies defaults', () => {
    const r = SearchSchema.parse({ query: 'hello' });
    expect(r).toMatchObject({ sort: 'relevance', sort_dir: 'desc', limit: 20 });
  });
  it('rejects empty query', () => {
    expect(() => SearchSchema.parse({ query: '' })).toThrow();
  });
  it('rejects bad sort', () => {
    expect(() => SearchSchema.parse({ query: 'x', sort: 'oldest' as never })).toThrow();
  });
});

describe('SlackMessageSendSchema', () => {
  it('accepts minimal payload', () => {
    expect(SlackMessageSendSchema.parse({ channel: 'C1', text: 'hi' })).toMatchObject({
      channel: 'C1',
      text: 'hi',
      reply_broadcast: false,
      unfurl_links: true,
      unfurl_media: true,
      link_names: true,
    });
  });
  it('rejects empty text', () => {
    expect(() => SlackMessageSendSchema.parse({ channel: 'C1', text: '' })).toThrow();
  });
  it('rejects text > 4000 chars', () => {
    expect(() => SlackMessageSendSchema.parse({ channel: 'C1', text: 'a'.repeat(4001) })).toThrow();
  });

  it('requires exactly one file upload body source', async () => {
    const { SlackFileUploadSchema } = await import('../../../src/utils/validators.js');
    expect(() => SlackFileUploadSchema.parse({ filename: 'empty.txt' })).toThrow(
      /Either content or file/,
    );
    expect(() =>
      SlackFileUploadSchema.parse({ filename: 'both.txt', content: 'x', file: 'x.txt' }),
    ).toThrow(/either content or file/i);
    expect(SlackFileUploadSchema.parse({ filename: 'ok.txt', content: 'x' })).toMatchObject({
      content: 'x',
    });
  });
});

describe('SlackChannelCreateSchema', () => {
  it('accepts valid name', () => {
    expect(SlackChannelCreateSchema.parse({ name: 'general' })).toEqual({ name: 'general' });
  });
  it('rejects > 21 chars', () => {
    expect(() => SlackChannelCreateSchema.parse({ name: 'a'.repeat(22) })).toThrow();
  });
});

describe('OAuthStateSchema', () => {
  const valid = {
    state: 'a'.repeat(32),
    redirect_uri: 'https://example.com/cb',
    scopes: ['chat:write'],
  };
  it('accepts valid', () => {
    expect(() => OAuthStateSchema.parse(valid)).not.toThrow();
  });
  it('rejects state < 32 chars', () => {
    expect(() => OAuthStateSchema.parse({ ...valid, state: 'short' })).toThrow();
  });
  it('rejects bad redirect_uri', () => {
    expect(() => OAuthStateSchema.parse({ ...valid, redirect_uri: 'not-a-url' })).toThrow();
  });
  it('rejects code_verifier < 43 chars', () => {
    expect(() => OAuthStateSchema.parse({ ...valid, code_verifier: 'a'.repeat(42) })).toThrow();
  });
  it('rejects code_verifier > 128 chars', () => {
    expect(() => OAuthStateSchema.parse({ ...valid, code_verifier: 'a'.repeat(129) })).toThrow();
  });
});

describe('AuditLogEntrySchema', () => {
  const base = {
    user: 'u',
    action: 'a',
    resource: 'r',
    details: { x: 1 },
    status: 'success' as const,
  };
  it('accepts minimal', () => {
    expect(() => AuditLogEntrySchema.parse(base)).not.toThrow();
  });
  it('rejects bad status', () => {
    expect(() => AuditLogEntrySchema.parse({ ...base, status: 'unknown' as never })).toThrow();
  });
  it('accepts valid ip', () => {
    expect(() => AuditLogEntrySchema.parse({ ...base, ip: '127.0.0.1' })).not.toThrow();
  });
  it('rejects invalid ip', () => {
    expect(() => AuditLogEntrySchema.parse({ ...base, ip: 'not-an-ip' })).toThrow();
  });
});

describe('createValidator + ValidationError', () => {
  const validate = createValidator(SlackChannelIdSchema);
  it('returns parsed value on success', () => {
    expect(validate('C1234567890')).toBe('C1234567890');
  });
  it('throws ValidationError on failure', () => {
    try {
      validate('');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).issues.length).toBeGreaterThan(0);
      return;
    }
    throw new Error('expected throw');
  });
});

describe('sanitizeHtml', () => {
  it('escapes all dangerous chars', () => {
    expect(sanitizeHtml(`<script>alert('x')</script>`)).toBe(
      '&lt;script&gt;alert(&#x27;x&#x27;)&lt;&#x2F;script&gt;',
    );
  });
  it('escapes double quotes', () => {
    expect(sanitizeHtml('"hi"')).toBe('&quot;hi&quot;');
  });
});

describe('sanitizeSlackMessage', () => {
  it('preserves user mentions', () => {
    expect(sanitizeSlackMessage('hi <@U123>')).toBe('hi <@U123>');
  });
  it('preserves channel mentions', () => {
    expect(sanitizeSlackMessage('see <#C123>')).toBe('see <#C123>');
  });
  it('preserves multiple individual mentions intact', () => {
    expect(sanitizeSlackMessage('<@U1> and <@U2> in <#C9>')).toBe('<@U1> and <@U2> in <#C9>');
  });
  it('strips !here / !channel / !everyone', () => {
    expect(sanitizeSlackMessage('<!here> <!channel> <!everyone>')).toBe('');
  });
  it('strips arbitrary <!…> mentions (e.g. subteam)', () => {
    expect(sanitizeSlackMessage('<!subteam^S123|name>')).toBe('');
  });
  it('strips broadcasts but keeps surrounding individual mentions', () => {
    expect(sanitizeSlackMessage('hey <@U1> <!channel> heads up')).toBe('hey <@U1>  heads up');
  });
  it('trims whitespace', () => {
    expect(sanitizeSlackMessage('  hello  ')).toBe('hello');
  });
});

describe('createErrorResponse / validationErrorToMcpError', () => {
  it('createErrorResponse omits data when undefined', () => {
    expect(createErrorResponse(-1, 'oops')).toEqual({ code: -1, message: 'oops' });
  });
  it('createErrorResponse includes data when provided', () => {
    expect(createErrorResponse(-1, 'oops', { x: 1 })).toEqual({
      code: -1,
      message: 'oops',
      data: { x: 1 },
    });
  });
  it('validationErrorToMcpError formats issues', () => {
    const err = new ValidationError('bad', [{ message: 'm1', path: [], code: 'custom' } as never]);
    const r = validationErrorToMcpError(err);
    expect(r.code).toBe(-32602);
    expect(r.message).toContain('m1');
  });
});
