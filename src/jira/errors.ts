export class SafeError extends Error {}

export function httpError(status: number, writing = false): SafeError {
  const reason = ({
    400: 'Invalid Jira request. Check JQL, input values or workflow requirements.',
    401: 'Jira authentication failed. Check JIRA_EMAIL, JIRA_API_TOKEN and JIRA_CLOUD_ID.',
    403: 'Jira denied access. Check token scopes and account/project permissions.',
    404: 'Jira item not found or not visible to this account.',
    429: 'Jira rate limit reached. Wait before retrying.',
  } as Record<number, string>)[status] ?? `Jira returned HTTP ${status}.`;
  return new SafeError(reason + (writing && status >= 500 ? ' Outcome uncertain; verify in Jira before retrying.' : ''));
}

export function redact(text: string, token: string, email: string): string {
  for (const secret of [token, Buffer.from(`${email}:${token}`).toString('base64')]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}
