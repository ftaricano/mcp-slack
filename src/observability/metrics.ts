import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const slackCallsCounter = new client.Counter({
  name: 'mcp_slack_calls_total',
  help: 'Slack API calls by tool and outcome',
  labelNames: ['tool', 'outcome'] as const,
  registers: [registry],
});

export const slackCallDuration = new client.Histogram({
  name: 'mcp_slack_call_duration_seconds',
  help: 'Slack API call latency by tool',
  labelNames: ['tool'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

/** For tests: zero out all metrics so assertions are deterministic. */
export function resetMetrics(): void {
  registry.resetMetrics();
}
