import type { Row } from '../src/part-time/model.js';
import type { Page } from '@playwright/test';
import { setup, fields, request, record, recordId, listRecord } from './part-time-fixtures.js';
export async function requestSetup(page: Page) {
  await setup(page);
  const state = {
    row: structuredClone(request) as Row,
    writes: [] as { path: string; method: string; body: Record<string, unknown>; revision?: string }[],
    failure: 0,
    unknown: false,
    readFailure: false,
    buttons: true,
  };
  await page.route('**/permission/me/objects/*', (route) =>
    route.fulfill({
      json: {
        objectCode: decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!),
        dataOperations: { read: true, create: true, update: true, delete: true },
        viewableFields: [
          ...fields,
          'employeeId',
          'originalEndDate',
          'requestRemark',
          'revision',
          'sequenceId',
          'dottedManagerId',
          'employmentType',
          'employmentForm',
        ],
        editableFields: [
          ...fields,
          'employeeId',
          'requestRemark',
          'sequenceId',
          'dottedManagerId',
          'employmentType',
          'employmentForm',
        ],
        buttons: state.buttons
          ? ['PartTimeApproval', 'PartTimeExtend', 'PartTimeEnd', 'Submit', 'Withdraw', 'Revoke', 'Delete'].map(
              (name) => ({ buttonCode: `Employment.${name}`, level: 'detail' }),
            )
          : [],
      },
    }),
  );
  await page.route('**/org/organizations?*', (route) =>
    route.fulfill({ json: { items: [{ id: record.fields.departmentId, name: '合成兼职部门' }] } }),
  );
  await page.route('**/employment/part-times?*', (route) =>
    route.fulfill({
      json: {
        items: new URL(route.request().url()).searchParams.get('view') === 'in_approval' ? [state.row] : [listRecord],
        total: 1,
        page: 1,
        pageSize: 30,
        hasDataPermission: true,
      },
    }),
  );
  await page.route('**/employment/part-time-requests{,/**}', async (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return state.readFailure
        ? route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } })
        : route.fulfill({ json: state.row });
    const path = new URL(req.url()).pathname;
    const body = req.postDataJSON();
    state.writes.push({ path, method: req.method(), body, revision: req.headers()['if-match'] });
    if (state.unknown) return route.abort();
    if (state.failure)
      return route.fulfill({
        status: state.failure,
        json: {
          error: {
            code: state.failure === 403 ? 'FORBIDDEN' : 'CONFLICT',
            message: state.failure === 403 ? '只有原发起人可以操作该兼职申请' : '新结束日期不能与原结束日期相同',
            details: { reason: state.failure === 403 ? 'PART_TIME_NOT_INITIATOR' : 'PART_TIME_NOT_EXTENDED' },
          },
        },
      });
    if (path.endsWith('/part-time-requests'))
      state.row = {
        ...request,
        kind: body.requestType,
        status: body.submit ? 'in_review' : 'draft',
        endDate: body.endDate ?? null,
        originalEndDate: body.requestType === 'add' ? null : record.endDate,
        employeeId: body.employeeId ?? record.employeeId,
        recordId: body.recordId ?? null,
        fields: body.fields ?? record.fields,
        effectiveDate: body.startDate ?? record.effectiveDate,
        serviceType: body.partTimeType ?? record.serviceType,
        requestRemark: body.requestRemark ?? null,
      };
    else
      state.row = {
        ...state.row,
        ...body,
        fields: { ...state.row.fields, ...body.fields },
        status: path.endsWith('/submit')
          ? 'in_review'
          : path.endsWith('/withdraw')
            ? 'draft'
            : path.endsWith('/revoke')
              ? 'voided'
              : req.method() === 'DELETE'
                ? 'deleted'
                : state.row.status,
      };
    state.row.revision = Number(state.row.revision) + 1;
    if (state.row.kind === 'extend' && String(state.row.endDate) < String(state.row.originalEndDate))
      state.row.warnings = [{ reason: 'PART_TIME_NOT_EXTENDED' }];
    const { primary: _p, employee: _e, ...receipt } = state.row;
    return route.fulfill({ status: path.endsWith('/part-time-requests') ? 201 : 200, json: receipt });
  });
  await page.reload();
  return state;
}
export { recordId };
