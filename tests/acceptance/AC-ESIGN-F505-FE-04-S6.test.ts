import { eq, offers } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { offerSigningWorld } from './AC-ESIGN-F505-S4-support.js';
import {
  click,
  confirm,
  control,
  dialog,
  mount,
  openSign,
  selectAll,
  text,
  until,
} from './AC-ESIGN-F505-FE-S6-support.js';

const db = useTestDb();

it('FE-04 写入成功但丢响应，按原命令回查；已提交后的详情读失败只重读任务', async () => {
  const w = await offerSigningWorld(db().db, 'FE04_UNKNOWN');
  await w.offer({ name: 'ZZ_F505_回查', revision: 7 });
  await w.template();
  let failMine = true;
  const requests = await mount(w, {
    intercept: async ({ path, method }, forward) => {
      if (method === 'POST') {
        const response = await forward();
        expect(response.status).toBe(201);
        throw new Error('lost response');
      }
      if (failMine && path.includes('/esign/mine/')) throw new Error('mine unavailable');
      return forward();
    },
  });
  await openSign('ZZ_F505_回查');
  await selectAll();
  await click(confirm());
  await until(() => text(dialog()).includes('结果待确认'), '保留未知命令');
  const posts = () => requests.filter(({ method }) => method === 'POST');
  expect(posts()).toEqual([expect.objectContaining({ revision: 7, key: expect.any(String) })]);
  await click(control('查询提交结果', dialog()!));
  await until(() => text(dialog()).includes('已提交，状态读取失败'), '读详情失败与命令失败区分');
  expect(requests.some(({ path }) => path === `/api/tenant/commands/${posts()[0]!.key}/result`)).toBe(true);
  failMine = false;
  await click(control('重读任务状态', dialog()!));
  await until(() => text(dialog()).includes('待员工签署'), '任务详情可重读');
  expect(posts()).toHaveLength(1);
  expect(await w.taskCount()).toBe(1);
});

it('FE-04 修订冲突保留选择，刷新后由操作者显式以新键提交', async () => {
  const w = await offerSigningWorld(db().db, 'FE04_CONFLICT');
  const source = await w.offer({ name: 'ZZ_F505_版本' });
  const template = await w.template();
  const requests = await mount(w);
  await openSign('ZZ_F505_版本');
  await selectAll();
  await w.inTenant((tx) => tx.update(offers).set({ revision: 2 }).where(eq(offers.id, source)));
  await click(confirm());
  await until(() => text(dialog()).includes('刷新签署上下文'), '冲突提示刷新');
  await click(control('刷新签署上下文', dialog()!));
  await until(() => confirm()?.disabled === false, '新 revision 下可显式重提');
  const posts = () => requests.filter(({ method }) => method === 'POST');
  expect(posts().map(({ revision }) => revision)).toEqual([1]);
  await click(confirm());
  await until(() => text(dialog()).includes('待员工签署'), '新命令已提交');
  expect(posts().map(({ revision, body }) => [revision, body])).toEqual([
    [1, { templateIds: [template.id] }],
    [2, { templateIds: [template.id] }],
  ]);
  expect(new Set(posts().map(({ key }) => key)).size).toBe(2);
});
