/**
 * F-479 S5 浏览器集成专用：全新隔离数据库、合成数据、真实离职 / 审批 / 附件路由；不连接开发库。
 * 复用验收夹具 exitWorld（已发布离职流程，审批节点表单含 attachmentRefs），身份按代理传入的 x-smoke-user 签名。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { APPROVAL, EMPLOYMENT_API, exitWorld, type ExitWorld } from '../../../tests/acceptance/AC-ATT-S2-support.js';
import { png } from '../../../tests/acceptance/AC-ATT-support.js';
import { pinExitGate } from '../../../tests/acceptance/support/tenant-api.js';
import { createTestDb } from '../../../packages/testkit/src/test-db.js';

const FIELDS = ['lastWorkDate', 'attachmentRefs'];
// HR 列表 / 详情要的字段（与 AC-ATT-15 同一口径，加上列表列）；HR 走夹具的受限授权器，范围全部
const HR_FIELDS = ['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'lastWorkDate', 'name', 'code'];
const HR_EXTRA = ['attachmentRefs', 'mode', 'exit', 'reasonCode', 'whereaboutsCode', 'departmentId', 'exitTypeCode'];
const hrAuthorize: Authorizer = () => true;
// 只转发业务头；浏览器的来源类头（origin / referer / sec-fetch-*）不进测试应用，身份由 x-smoke-user 重新签名
const SKIPPED = new Set(['host', 'connection', 'content-length', 'content-type', 'cookie', 'origin', 'referer']);
const forwarded = (key: string) => !SKIPPED.has(key) && !key.startsWith('sec-') && key !== 'x-smoke-user';
const persona = (person: { userId: string; employeeId: string }) => ({
  userId: person.userId,
  employeeId: person.employeeId,
});

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as unknown) : undefined;
}

/**
 * 租户 C（AC-FE-ATT-09 / AC-ATT-26 同一场景）：两节点流程，首节点 lead 同意、第二节点 X 驳回；本人删去 P 再提交。
 * 第二轮 lead 待办（现值只有 Q），X 是已办（办理时冻结份有 P、Q）。办理走真实授权引擎，办理份的披露上限才是真的。
 */
async function seedFrozen(db: Parameters<typeof exitWorld>[0]) {
  const x = await exitWorld(db, 'F479-C', { leadFirst: true });
  const me = await x.a.person('合成本人丁');
  const [p, q] = await x.uploads(me, 2);
  // 改动字段里有审批人看不到的会被盲审拦下：办理人先授任职对象全部字段
  const fields = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);
  await x.grantFields(x.lead!.userId, fields);
  await x.grantFields(x.approver.userId, fields);
  const { draft, instance, task } = await x.submitted(me, [p!.id, q!.id]);
  const act = (user: { userId: string }, taskId: string, action: string, revision: number) =>
    x.asUser(user, `${APPROVAL}/tasks/${taskId}/${action}`, 'POST', { ifMatch: revision, body: { comment: '办理' } });
  const approved = await act(x.lead!, task.id, 'approve', instance.revision);
  if (approved.status !== 200) throw new Error(`lead approve ${approved.status}: ${await approved.text()}`);
  const view = await x.w.detail(instance.id, me.userId);
  const rejected = await act(x.approver, x.w.pending(view)[0]!.id, 'reject', view.revision);
  if (rejected.status !== 200) throw new Error(`reject ${rejected.status}: ${await rejected.text()}`);
  const returned = await x.read(me, draft.id);
  const saved = await x.w.json<{ revision: number }>(await x.patch(me, returned, { attachmentRefs: [q!.id] }));
  const again = await x.submit(me, { id: draft.id, revision: saved.revision });
  if (again.status !== 200) throw new Error(`resubmit ${again.status}: ${await again.text()}`);
  const running = (await x.w.instanceOfAll(draft.id, me.userId)).find((item) => item.status === 'running')!;
  return { x, me, p: p!.id, q: q!.id, instanceId: running.id };
}

/** 两个租户的合成场景：A 有本人 / 审批人（有字段权）/ 无字段权审批人 / HR；B 有一张带附件的本人草稿。 */
async function seed(db: Parameters<typeof exitWorld>[0]) {
  const a = await exitWorld(db, 'F479-A');
  const b = await exitWorld(db, 'F479-B');
  const employee = await a.a.person('合成本人甲');
  // 无字段权审批人（AC-FE-ATT-07）：另一员工的单由审批人甲转交给他，他只有待办、没有 attachmentRefs 字段权
  const colleague = await a.a.person('合成本人乙');
  const blind = await a.a.person('合成无字段审批人');
  await a.grantFields(a.approver.userId, FIELDS);
  await a.grantFields(blind.userId, ['lastWorkDate']);
  const [file] = await a.uploads(colleague, 1);
  const scene = await a.submitted(colleague, [file!.id]);
  const moved = await a.w.taskAction(a.approver.userId, scene.task.id, 'transfer', scene.instance.revision, {
    toUserId: blind.userId,
  });
  if (moved.status !== 200) throw new Error(`transfer failed ${moved.status}: ${await moved.text()}`);
  // 另一租户（AC-FE-ATT-10 切换租户）：本人一张草稿带一张附件
  const other = await b.a.person('合成本人丙');
  const [otherFile] = await b.uploads(other, 1);
  const draft = await b.createDraft(other, [otherFile!.id]);
  const frozen = await seedFrozen(db);
  return { a, b, employee, blind, other, blindInstance: scene.instance.id, otherDraft: draft.id, frozen };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** 审批人驳回（AC-FE-ATT-08 的前置；驳回本身不是本片的界面）。 */
async function reject(world: Seeded, exitId: string) {
  const { instance, task } = await world.a.instanceOf({ id: exitId }, world.employee);
  return world.a.w.taskAction(world.a.approver.userId, task.id, 'reject', instance.revision, {
    comment: '请补充材料',
  });
}

function handler(world: Seeded) {
  const { a, b } = world;
  const worlds = new Map<string, ExitWorld>([
    [a.w.tenant.id, a],
    [b.w.tenant.id, b],
    [world.frozen.x.w.tenant.id, world.frozen.x],
  ]);
  const hrApi = a.restrictedHr(hrAuthorize, [...HR_FIELDS, ...HR_EXTRA]);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const body = await bodyOf(req);
    if (req.method === 'POST' && url.pathname === '/__smoke/reject') {
      const done = await reject(world, (body as { exitId: string }).exitId);
      res.writeHead(done.status, { 'content-type': 'application/json' });
      res.end(await done.text());
      return;
    }
    const tenant = String(req.headers['x-tenant-id'] ?? '');
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([key, value]) =>
        forwarded(key) && typeof value === 'string' ? [[key, value]] : [],
      ),
    );
    const user = String(req.headers['x-smoke-user'] ?? '');
    const init = { headers, body, idempotencyKey: null };
    const response =
      user === a.w.hr.id && url.pathname.startsWith(EMPLOYMENT_API)
        ? await hrApi(`${url.pathname.slice(EMPLOYMENT_API.length)}${url.search}`, req.method!, init)
        : await (worlds.get(tenant) ?? a).a.api.request(req.method!, `${url.pathname}${url.search}`, {
            user,
            tenant,
            ...init,
          });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

export async function startExitAttachmentBackend() {
  pinExitGate('enforce');
  const handle = await createTestDb();
  try {
    const world = await seed(handle.db);
    const serve = handler(world);
    const server = createServer((req, res) => {
      serve(req, res).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`F479 test backend failed: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { a, b } = world;
    return {
      manifest: {
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        a: {
          tenant: a.w.tenant.id,
          employee: persona(world.employee),
          approver: persona(a.approver),
          blind: persona(world.blind),
          hr: { userId: a.w.hr.id, employeeId: '' },
          blindInstance: world.blindInstance,
        },
        b: { tenant: b.w.tenant.id, employee: persona(world.other), draft: world.otherDraft },
        c: {
          tenant: world.frozen.x.w.tenant.id,
          handled: persona(world.frozen.x.approver),
          pending: persona(world.frozen.x.lead!),
          instanceId: world.frozen.instanceId,
          dropped: world.frozen.p,
          kept: world.frozen.q,
        },
        // 浏览器上传用的两张合成位图（与验收夹具同一生成器）
        images: [png(3, 3), png(4, 4)].map((bytes) => bytes.toString('base64')),
      },
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
