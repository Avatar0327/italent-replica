import { text } from './messages.js';
export const BASE = '/api/tenant/org/organizations';
export class OrgApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function orgRequest<T>(tenantId: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, ...options.headers },
  });
  const payload = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new OrgApiError(response.status, payload.error?.message ?? text.failed);
  return payload;
}
