/** AC-EV-F091b / DEC-413②：真实活动引用、HTTP socket 与 PostgreSQL 协调锁。 */
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Store from '../../apps/api/src/modules/evaluation/store.js';
import {
  activityFixtures,
  activityWorld,
  sendableChainWithId,
  type ActivityFixtures,
  type ActivityView,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { type FormView } from './AC-EV-form-support.js';
import { errorOf, EV_BASE, ok } from './AC-EV-support.js';

const race = vi.hoisted(() => ({
  firstId: '',
  reached: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));
vi.mock('../../apps/api/src/modules/evaluation/store.js', async (load) => {
  const original = await load<typeof Store>();
  return {
    ...original,
    lockEditable: async (...args: Parameters<typeof original.lockEditable>) => {
      const row = await original.lockEditable(...args);
      if (args[3] === race.firstId && race.reached) {
        const reached = race.reached;
        race.reached = undefined;
        reached();
        await race.release; // 只控制调度：生产协调入口与真实事务锁均已执行。
      }
      return row;
    },
  };
});
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
const testDb = useTestDb();

describe('AC-EV-F091b 被活动引用的评价表拒绝停用', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  let server: Server;
  beforeAll(async () => {
    w = await activityWorld(testDb().db);
    // 保留夹具生成的签名身份头，将请求经真实 socket 送入同一个生产 Hono 应用。
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const body = Buffer.concat(chunks).toString();
      const response = await w.setup.app.fetch(
        new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, ...(body ? { body } : {}) }),
      );
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });
      res.writeHead(response.status, responseHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务未监听 TCP');
    const origin = `http://127.0.0.1:${address.port}`;
    vi.spyOn(w.setup.app, 'request').mockImplementation((input, init) => {
      if (typeof input !== 'string') throw new Error('活动夹具应使用相对路径');
      return fetch(new URL(input, origin), init);
    });
    f = await activityFixtures(w);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const patchForm = (form: { id: string; revision: number }, body: unknown = { enabled: false }) =>
    w.setup.request('PATCH', `${EV_BASE}/evaluation-forms/${form.id}`, {
      ...w.asAdmin,
      ifMatch: form.revision,
      body,
    });
  const readForm = async (id: string) =>
    ok<FormView>(await w.setup.request('GET', `${EV_BASE}/evaluation-forms/${id}`, w.asAdmin));
  const patchActivity = (activity: ActivityView, body: unknown) =>
    w.setup.request('PATCH', `${EV_BASE}/activities/${activity.id}`, {
      ...w.asAdmin,
      ifMatch: activity.revision,
      body,
    });
  const using = async (formId: string) =>
    w.adminActivity(f.body({ chains: f.chains(formId), categoryIds: [(await w.qlCategory()).id] }));
  const expectInUse = async (response: Response) => {
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await errorOf(response)).toEqual({ code: 'CONFLICT', reason: 'EVALUATION_FORM_IN_USE' });
    expect(await response.json()).toMatchObject({
      error: { message: '已在活动中使用此评价表，无法停用' },
    });
  };

  it.each(['draft', 'published', 'completed'] as const)(
    'AC-EV-F091b-01 %s 活动引用时拒绝停用，评价表与活动均不变',
    async (status) => {
      const form = await w.form();
      const activity = await using(form.id);
      await w.setStatus(activity.id, status);
      const beforeForm = await readForm(form.id);
      const beforeActivity = await w.adminRead(activity.id);
      await expectInUse(await patchForm(beforeForm, { enabled: false, name: '拒绝时不应保存' }));
      expect(await readForm(form.id)).toEqual(beforeForm);
      expect(await w.adminRead(activity.id)).toEqual(beforeActivity);
    },
  );

  it('AC-EV-F091b-02 清除最后一个活动环节引用后可停用，仍有其他引用时拒绝', async () => {
    const form = await w.form();
    const activities = [await using(form.id), await using(form.id)];
    const before = await readForm(form.id);
    for (const [index, activity] of activities.entries()) {
      const chains = activity.chains
        .map(sendableChainWithId)
        .map((chain) => (chain['type'] === 'defense' ? { ...chain, formId: f.form1.id } : chain));
      await ok(await patchActivity(activity, { chains }));
      expect((await w.adminRead(activity.id)).chains.some((chain) => chain.formId === form.id)).toBe(false);
      if (index === 0) {
        await expectInUse(await patchForm(before));
        expect(await readForm(form.id)).toEqual(before);
      }
    }
    await ok(await patchForm(before));
    expect(await readForm(form.id)).toMatchObject({ enabled: false, revision: before.revision + 1 });
  });

  it('AC-EV-F091b-03 已停用评价表的既有引用可保留，新活动引用仍拒绝', async () => {
    const form = await w.form();
    const activity = await using(form.id);
    await w.forceDisable('ev_forms', form.id); // 构造旧数据，产品入口已禁止产生这种状态。
    const disabled = await readForm(form.id);
    await ok(await patchForm(disabled));
    const kept = await ok<ActivityView>(
      await patchActivity(activity, {
        name: '保留既有停用表引用',
        chains: activity.chains.map(sendableChainWithId),
      }),
    );
    expect(kept.chains.map((chain) => chain.formId)).toEqual(activity.chains.map((chain) => chain.formId));
    const response = await w.setup.request('POST', `${EV_BASE}/activities`, {
      ...w.asAdmin,
      ifMatch: 0,
      body: f.body({ chains: f.chains(form.id), categoryIds: [(await w.qlCategory()).id] }),
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await errorOf(response)).toEqual({ code: 'VALIDATION_FAILED', reason: 'REFERENCE_DISABLED' });
    expect(await w.adminRead(activity.id)).toEqual(kept);
    expect(await readForm(form.id)).toMatchObject({ enabled: false, revision: disabled.revision + 1 });
  });

  describe.skipIf(!process.env['TEST_DATABASE_URL'])('真 PostgreSQL 交错', () => {
    it.each(['活动先行', '停用先行'])(
      'AC-EV-F091b-04 %s：新增环节引用 × 停用按 coordinateActivityForms 锁序串行',
      async (order) => {
        const form = await w.form();
        const activity = await using(f.form1.id);
        const chains = activity.chains.map(sendableChainWithId);
        const { id: _id, ...extra } = chains.find((chain) => chain['type'] === 'defense')!;
        chains.splice(chains.length - 1, 0, { ...extra, formId: form.id, name: '新增答辩' });
        const edit = () => patchActivity(activity, { chains });
        const disable = () => patchForm(form);
        const reached = gate();
        const release = gate();
        race.firstId = order === '活动先行' ? activity.id : form.id;
        race.reached = reached.open;
        race.release = release.promise;
        const first = order === '活动先行' ? edit() : disable();
        let second: Promise<Response> | undefined;
        try {
          await reached.promise;
          second = order === '活动先行' ? disable() : edit();
          let waiting = false;
          const deadline = Date.now() + 10_000;
          while (!waiting && Date.now() < deadline) {
            const result = await testDb().db.execute(sql`SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
                AND pid <> pg_backend_pid()`);
            waiting = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows).length > 0;
            if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(waiting, '后到请求必须实际等待生产协调锁').toBe(true);
        } finally {
          release.open();
          await Promise.allSettled([first, second]);
          race.firstId = '';
        }
        const responses = await Promise.all([first, second!]);
        if (order === '活动先行') {
          await ok(responses[0]!);
          await expectInUse(responses[1]!);
          expect(await readForm(form.id)).toMatchObject({ enabled: true, revision: form.revision });
          const saved = await w.adminRead(activity.id);
          expect(saved.revision).toBe(activity.revision + 1);
          expect(saved.chains.filter((chain) => chain.formId === form.id)).toHaveLength(1);
        } else {
          await ok(responses[0]!);
          expect(responses[1]!.status, await responses[1]!.clone().text()).toBe(400);
          expect(await errorOf(responses[1]!)).toEqual({ code: 'VALIDATION_FAILED', reason: 'REFERENCE_DISABLED' });
          expect(await w.adminRead(activity.id)).toEqual(activity);
          expect(await readForm(form.id)).toMatchObject({ enabled: false, revision: form.revision + 1 });
        }
      },
    );
  });
});
