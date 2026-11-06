/** DEC-790：本人申请复用命令台账；查台账前复核当前绑定、按钮、专属字段和对象归属。 */
import type { RoutePolicy } from '../../route-policy/types.js';
import {
  button,
  projector,
  self,
  write,
  object,
  noButton,
  noScope,
  noFields,
  BAD_REQUEST,
} from '../../route-policy/presets.js';

const capability = (operation: 'create' | 'update') =>
  object({
    object: 'TenantBase.EmploymentRecord',
    operation,
    button: noButton('仅披露表单能力'),
    scope: noScope('仅披露表单能力'),
    fields: noFields('仅披露字段模式'),
  });
function requestPolicy(code: string, writing = false, identified = false, form = false): RoutePolicy {
  return self({
    button: button(code, 'detail'),
    guards: writing ? ['selfService.application', 'employment.linkage'] : ['selfService.application'],
    ...(form ? { optional: { fieldModes: capability('create'), updateFieldModes: capability('update') } } : {}),
    fields: projector('selfService.request', 'selfService.request'),
    ...(identified ? { invalidId: BAD_REQUEST } : {}),
    ...(writing
      ? {
          write: write('body.fields+customFields', 'employment.result', 'employment.result', {
            preconditions: ['checkApplication', 'requireApplicationAccess', 'self.check'],
            ledger: 'single',
          }),
        }
      : {}),
  });
}
export const SELF_APPLICATION_POLICIES = {
  'GET /exit-requests/form': requestPolicy('Exit.Self', false, false, true),
  'GET /exit-requests/:id': requestPolicy('Exit.Self', false, true),
  'POST /exit-requests': requestPolicy('Exit.Self', true),
  'PATCH /exit-requests/:id': requestPolicy('Exit.Self', true, true),
  'POST /exit-requests/:id/submit': requestPolicy('Exit.Self', true, true),
  'GET /part-time-requests/form': requestPolicy('PartTime.Self', false, false, true),
  'GET /part-time-requests/references/:code': requestPolicy('PartTime.Self'),
  'GET /part-time-requests/:id': requestPolicy('PartTime.Self', false, true),
  'POST /part-time-requests': requestPolicy('PartTime.Self', true),
  'PATCH /part-time-requests/:id': requestPolicy('PartTime.Self', true, true),
  'POST /part-time-requests/:id/submit': requestPolicy('PartTime.Self', true, true),
};
