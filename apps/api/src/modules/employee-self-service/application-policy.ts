/** DEC-790：本人申请复用命令台账；查台账前复核当前绑定、按钮、专属字段和对象归属。 */
import type { RoutePolicy } from '../../route-policy/types.js';
import { button, projector, self, write, BAD_REQUEST } from '../../route-policy/presets.js';

function requestPolicy(code: string, writing = false, identified = false): RoutePolicy {
  return self({
    button: button(code, 'detail'),
    guards: ['selfService.application'],
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
  'GET /exit-requests/form': requestPolicy('Exit.Self'),
  'GET /exit-requests/:id': requestPolicy('Exit.Self', false, true),
  'POST /exit-requests': requestPolicy('Exit.Self', true),
  'PATCH /exit-requests/:id': requestPolicy('Exit.Self', true, true),
  'POST /exit-requests/:id/submit': requestPolicy('Exit.Self', true, true),
  'GET /part-time-requests/form': requestPolicy('PartTime.Self'),
  'GET /part-time-requests/references/:code': requestPolicy('PartTime.Self'),
  'GET /part-time-requests/:id': requestPolicy('PartTime.Self', false, true),
  'POST /part-time-requests': requestPolicy('PartTime.Self', true),
  'PATCH /part-time-requests/:id': requestPolicy('PartTime.Self', true, true),
  'POST /part-time-requests/:id/submit': requestPolicy('PartTime.Self', true, true),
};
