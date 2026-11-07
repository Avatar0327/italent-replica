import { withTenant } from '@italent/db';
import { tenantLocalDate, type SelfApplicationKind } from '@italent/domain';
import type { Context, Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { AppError } from '../../errors.js';
import { jsonBody, pageQuery, revision, runWrite, uuidParam } from '../employment/context.js';
import { businessDate } from '../employment/fields.js';
import { listEmployees } from '../employment/employees.js';
import { requireAttachmentRead } from '../attachments/access.js';
import { readCarrierAttachment, respondAttachment } from '../attachments/carrier-read.js';
import { selfAccess } from './access.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import {
  applicationForm,
  ownExitAttachmentRefs,
  ownRequest,
  projectApplication,
  requireApplicationAccess,
  selfPartTimeDepartmentScope,
} from './application-access.js';
import { applicationInput, checkApplication, writeApplication, type SelfRequestAction } from './application-service.js';

export function registerSelfApplicationRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/exit-requests/form', (c) => form(c, deps, 'exit'));
  router.get('/part-time-requests/form', (c) => form(c, deps, 'partTime'));
  router.get('/part-time-requests/references/:code', (c) => references(c, deps));
  router.post('/exit-requests', (c) => write(c, deps, 'exit', 'create'));
  router.patch('/exit-requests/:id', (c) => write(c, deps, 'exit', 'update'));
  router.post('/exit-requests/:id/submit', (c) => write(c, deps, 'exit', 'submit'));
  router.get('/exit-requests/:id', (c) => read(c, deps, 'exit'));
  router.get('/exit-requests/:id/attachments/:fileId/content', (c) => downloadAttachment(c, deps));
  router.post('/part-time-requests', (c) => write(c, deps, 'partTime', 'create'));
  router.patch('/part-time-requests/:id', (c) => write(c, deps, 'partTime', 'update'));
  router.post('/part-time-requests/:id/submit', (c) => write(c, deps, 'partTime', 'submit'));
  router.get('/part-time-requests/:id', (c) => read(c, deps, 'partTime'));
}
async function form(c: Context<TenantEnv>, deps: TenantRouteDeps, kind: SelfApplicationKind) {
  const self = await selfAccess(c, deps, 0, kind);
  return c.json(await withTenant(deps.db, self.ctx.tenantId, (tx) => applicationForm(tx, self, kind)));
}
async function read(c: Context<TenantEnv>, deps: TenantRouteDeps, kind: SelfApplicationKind) {
  const self = await selfAccess(c, deps, 0, kind);
  const id = uuidParam(c);
  const row = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
    await requireApplicationAccess(tx, self, kind);
    return ownRequest(tx, self, kind, id);
  });
  return c.json(await projectApplication(self, row));
}
/** F-479 §3.3 本人载体：本人单（ownRequest）+ attachmentRefs 查看权；缺查看权 / 文件不属于本单一律 404“附件不存在”。 */
async function downloadAttachment(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const self = await selfAccess(c, deps, 0, 'exit');
  const id = uuidParam(c);
  const fileId = uuidParam(c, 'fileId');
  const { row, bytes } = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
    await requireAttachmentRead(tx, self);
    const refs = await ownExitAttachmentRefs(tx, self, id);
    return readCarrierAttachment(tx, self.ctx.tenantId, id, refs, fileId);
  });
  return respondAttachment(c, row, bytes);
}
async function write(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  kind: SelfApplicationKind,
  action: SelfRequestAction,
) {
  const self = await selfAccess(c, deps, revision(c), kind);
  const id = action === 'create' ? undefined : uuidParam(c);
  const body = applicationInput(kind, action, await jsonBody(c));
  return runWrite(
    c,
    self.deps,
    self.ctx,
    { employeeId: self.employee.id, body, id },
    async (tx, ctx) => {
      const result = await writeApplication(tx, self, ctx, kind, action, body, id);
      const record = await ownRequest(tx, self, kind, result.id);
      return {
        status: action === 'create' ? 201 : 200,
        body: { ...record, ...('warnings' in result ? { warnings: result.warnings } : {}) },
      };
    },
    {
      guard: { before: (tx) => checkApplication(tx, self, kind, action, body, id) },
      project: (body) => projectApplication(self, body),
    },
  );
}
async function references(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const self = await selfAccess(c, deps, 0, 'partTime');
  const code = c.req.param('code') ?? '';
  const date = businessDate(c.req.query('asOf') ?? tenantLocalDate(self.ctx.now, self.ctx.timezone));
  const page = pageQuery(c);
  const items = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
    await requireApplicationAccess(tx, self, 'partTime');
    const visible = await getModuleViewableFieldsInTransaction(self.deps, self.ctx, EMPLOYMENT_OBJECT, tx);
    if (!visible?.has(code)) throw new AppError('FORBIDDEN', '无权查看此字段');
    if (code === 'departmentId') return selfPartTimeDepartmentScope(tx, self, date);
    if (code !== 'directManagerId') throw new AppError('VALIDATION_FAILED', '字段不是可选引用');
    // DEC-790：经理候选全租户在职员工，仅披露 id/name，不借此开放人员档案。
    return (
      await listEmployees(tx, self.ctx.tenantId, date, page, { status: 'employed', name: c.req.query('name') ?? '' })
    ).map(({ id, name }) => ({ id, name }));
  });
  return c.json({ items });
}
