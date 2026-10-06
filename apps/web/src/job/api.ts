import { text } from './messages.js';
import type { Choice } from './JobForm.js';
export interface Job extends Choice {
  readonly revision: number;
  readonly sequenceId?: string | null;
}
export interface JobList {
  readonly items: Job[];
  readonly today: string;
}
export class JobApiError extends Error {}
export async function request<T>(tenantId: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/tenant/${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, ...options.headers },
  });
  const result = (await response.json()) as T & { error?: { message: string } };
  if (response.status >= 500) throw new Error(text.uncertain);
  if (!response.ok) throw new JobApiError(result.error?.message ?? text.failed);
  return result;
}
