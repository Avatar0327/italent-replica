/** B6b 真 PG：在真实 HTTP 写事务已持锁后暂停，观察竞争请求锁等待，两种顺序都验证。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import * as structure from '../../apps/api/src/modules/talent-review/template-structure.js';
import { FORM } from '../../apps/api/src/modules/talent-review/form-service.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { formBody } from './AC-TR-form-flow-support.js';
import { indicatorModule, templateBody, templateWorld, type TemplateView } from './AC-TR-template-support.js';

const testDb = useTestDb();
const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function pauseVersion() {
  const entered = barrier(),
    resume = barrier();
  const original = structure.writeVersion;
  const spy = vi.spyOn(structure, 'writeVersion').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return original(...args);
  });
  return { entered, resume, spy };
}
function pauseForm() {
  const entered = barrier(),
    resume = barrier();
  const original = FORM.load!;
  const spy = vi.spyOn(FORM, 'load').mockImplementationOnce(async (...args) => {
    const row = await original(...args);
    entered.resolve();
    await resume.promise;
    return row;
  });
  return { entered, resume, spy };
}
async function arrived(pause: Pick<ReturnType<typeof pauseVersion>, 'entered'>, request: Promise<Response>) {
  await Promise.race([
    pause.entered.promise,
    request.then(async (response) => {
      throw new Error(`请求未到持锁边界即结束：${response.status} ${await response.clone().text()}`);
    }),
  ]);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TR-template-copy 真 PG 交错', () => {
  it.each([false, true])('复制 × 原件结构编辑，编辑先持锁=%s', async (editFirst) => {
    const db = testDb().db;
    const w = await templateWorld(db, `b6b-pg-copy-${editFirst}`);
    const rule = await w.scoreRule();
    const target = await w.field({ kind: 'number' });
    const t = await w.template(
      templateBody(w.orgId, {
        modules: [indicatorModule(rule.id, { name: '业绩' })],
        resultRules: [{ targetFieldId: target.id, formula: '模块.业绩.得分', priority: 0 }],
      }),
    );
    const copy = () =>
      w.trRequest('POST', `/templates/${t.id}/copy`, {
        ifMatch: t.revision,
        body: { name: '并发复制' },
      });
    const edit = () => w.patch(t, { modules: [indicatorModule(rule.id, { id: t.modules[0]!.id, name: '编辑后' })] });
    const pause = pauseVersion();
    const first = editFirst ? edit() : copy();
    let second: Promise<Response> | undefined;
    try {
      await arrived(pause, first);
      second = editFirst ? copy() : edit();
      await waitForBlocked(db, 1);
      pause.resume.resolve();
      const a = await first,
        b = await second;
      expect(a.status, await a.clone().text()).toBe(editFirst ? 200 : 201);
      expect(b.status, await b.clone().text()).toBe(editFirst ? 409 : 200);
      if (!editFirst) {
        const duplicate = (await a.json()) as TemplateView;
        expect(duplicate.resultRules).toMatchObject([{ formula: '模块.业绩.得分' }]);
        expect((await w.read(duplicate.id)).body.modules[0]!.name).toBe('业绩');
      }
      expect((await w.read(t.id)).body).toMatchObject({
        currentVersionNo: 2,
        revision: 2,
        resultRules: [{ formula: '模块.编辑后.得分' }],
      });
    } finally {
      pause.resume.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      pause.spy.mockRestore();
    }
  });

  it.each([false, true])('表单删除 × 模板新增引用，删除先持锁=%s', async (deleteFirst) => {
    const db = testDb().db;
    const w = await templateWorld(db, `b6b-pg-form-${deleteFirst}`);
    const { flow } = await w.threeStepFlow();
    const form = await w.created<{ id: string }>('/forms', formBody([]));
    const t = await w.template(templateBody(w.orgId, { flowId: flow.id }));
    const remove = () => w.trRequest('DELETE', `/forms/${form.id}`, { ifMatch: 1 });
    const reference = () => w.patch(t, { stepForms: [{ nodeKey: 'self', purpose: 'info', formId: form.id }] });
    const pause = deleteFirst ? pauseForm() : pauseVersion();
    const first = deleteFirst ? remove() : reference();
    let second: Promise<Response> | undefined;
    try {
      await arrived(pause, first);
      second = deleteFirst ? reference() : remove();
      await waitForBlocked(db, 1);
      pause.resume.resolve();
      expect((await first).status).toBe(200);
      const rejected = await second;
      expect(rejected.status, await rejected.clone().text()).toBe(deleteFirst ? 404 : 409);
      if (!deleteFirst) expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'FORM_IN_USE' } } });
      const current = (await w.read(t.id)).body;
      expect(current.revision).toBe(deleteFirst ? 1 : 2);
      expect(current.stepForms).toEqual(
        deleteFirst ? [] : expect.arrayContaining([expect.objectContaining({ formId: form.id })]),
      );
    } finally {
      pause.resume.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      pause.spy.mockRestore();
    }
  });
});
