import { newCommand, type ApiClient } from '../foundation/client.js';
import { base, scopeInput, userInput, type Scope, type GrantReceipt } from './model.js';
export function settingsApi(api: ApiClient) {
  return {
    createGrant: (values: Record<string, unknown>) =>
      api.request<GrantReceipt>(`${base}/grants`, { method: 'POST', command: newCommand(values) }),
    createUser: (values: Record<string, unknown>) =>
      api.request(`${base}/users`, {
        method: 'POST',
        command: newCommand(userInput(values)),
      }),
    revoke: (grant: { id: string; revision: number }) =>
      api.request(`${base}/grants/${grant.id}/revoke`, {
        method: 'POST',
        command: newCommand({}, grant.revision),
      }),
    saveScope: (scope: Scope, values: Record<string, unknown>) =>
      api.request(`${base}/scopes/${encodeURIComponent(scope.userId)}/${encodeURIComponent(scope.appCode)}`, {
        method: 'PUT',
        command: newCommand(scopeInput(values), scope.revision),
      }),
  };
}
