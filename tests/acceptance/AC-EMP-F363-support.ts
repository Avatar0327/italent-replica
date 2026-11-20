import { expect } from 'vitest';
import type { RequestOptions } from './support/tenant-api.js';

export type FormRequest = (method: string, path: string, options?: RequestOptions) => Promise<Response>;

/** 经真实字典路由停用；不直接篡改启用标记。 */
export async function disableForm(request: FormRequest, code = 'regular') {
  const list = await request('GET', '/employment-forms');
  expect(list.status).toBe(200);
  const { items } = (await list.json()) as { items: { id: string; code: string; revision: number }[] };
  const form = items.find((item) => item.code === code)!;
  return request('PUT', `/employment-forms/${form.id}`, {
    ifMatch: form.revision,
    body: { enabled: false },
  });
}

export async function formRefused(response: Response) {
  expect(response.status, await response.clone().text()).toBe(422);
  expect(await response.json()).toMatchObject({
    error: { code: 'EMPLOYMENT_FORM_INVALID', details: { reason: 'EMPLOYMENT_FORM_DISABLED' } },
  });
}
