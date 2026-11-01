import type { ApiClient, Command } from '../../foundation/client.js';
import { base, validProcess, acceptProcessReceipt, type ProcessView, type ProcessSummary } from './model.js';
import { m } from './messages.js';

export async function readProcess(api: ApiClient, id: string, signal?: AbortSignal): Promise<ProcessView> {
  const value = await api.request<unknown>(`${base}/${encodeURIComponent(id)}`, { signal });
  if (!validProcess(value, id)) throw new Error(m.invalidReceipt);
  return value;
}
export async function readProcesses(api: ApiClient, status: string, page: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ status, page: String(page), pageSize: '20' });
  const value = await api.request<{ items: ProcessSummary[] }>(`${base}?${query}`, { signal });
  if (!Array.isArray(value?.items)) throw new Error(m.invalidReceipt);
  return value.items;
}
export async function writeProcess(api: ApiClient, id: string, action: 'draft' | 'versions', command: Command) {
  const value = await api.request<unknown>(`${base}/${encodeURIComponent(id)}/${action}`, {
    method: action === 'draft' ? 'PUT' : 'POST',
    command,
  });
  return acceptProcessReceipt(value, id, command.revision!);
}
