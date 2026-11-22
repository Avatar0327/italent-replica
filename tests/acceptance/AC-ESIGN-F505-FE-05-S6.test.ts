import { resolve } from 'node:path';
import { ESIGN_REMIND_TEMPLATE, renderEsignNotice } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import type { ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { RECORD, offerSigningWorld, recordsPath, taskPath } from './AC-ESIGN-F505-S4-support.js';
import { insertAnchor, insertTask } from './AC-ESIGN-F505-support.js';
import {
  act,
  click,
  confirm,
  control,
  dialog,
  mount,
  openSign,
  row,
  selectAll,
  text,
  until,
} from './AC-ESIGN-F505-FE-S6-support.js';

const { ScenesPage } = await import(resolve('apps/web/src/esign/ScenesPage.tsx'));
const { sceneText } = await import(resolve('apps/web/src/esign/sign-model.ts'));
const db = useTestDb();

it('AC-ESIGN-F505-FE-05 场景设置从三个真实读口取得各自配置', async () => {
  const w = await offerSigningWorld(db().db, 'FE05');
  const scenePath = '/api/tenant/esign/scenes';
  const save = await w.access()('PUT', `${scenePath}/offer`, {
    body: { validityDays: 13, remindBeforeExpiry: true },
    ifMatch: 0,
  });
  expect(save.status).toBe(200);
  await mount(w, {}, ScenesPage);
  await until(() => row('Offer电子签署') && row('入职电子签署') && row('调动电子签署'), '三行配置加载');
  expect(row('Offer电子签署')?.textContent ?? '', '同表显示 Offer 场景及其独立读值').toContain('13 天');
  expect(row('入职电子签署')?.textContent).toContain('2 天');
  expect(row('调动电子签署')?.textContent).toContain('2 天');
  await click(control('编辑', row('Offer电子签署')!));
  expect(document.querySelector('.ant-drawer')?.textContent).toContain('Offer电子签署');
});

it('AC-ESIGN-F505-FE-05 我的签署及记录采用与站内通知一致的场景名，陌生值使用受控文案', () => {
  expect(['transfer', 'offer', 'entry'].map(sceneText)).toEqual(['调动电子签署', 'Offer电子签署', '入职电子签署']);
  for (const scene of ['offer', 'entry']) {
    const notice = renderEsignNotice(ESIGN_REMIND_TEMPLATE, {
      scene,
      taskNumber: '12345678-1234-4123-8123-123456789000',
    });
    expect(notice?.body).toContain(sceneText(scene));
  }
  expect(sceneText('constructor')).toBe('无法识别的签署场景');
  expect(sceneText(undefined)).toBe('--');
});

it.each(['服务端裁剪', '当前字段权收窄'])('AC-ESIGN-F505-FE-05 %s 后来源历史隐藏状态与文件', async (mode) => {
  const w = await offerSigningWorld(db().db, 'FE05_FIELDS');
  const sourceId = await w.offer({ name: 'ZZ_F505_字段裁剪' });
  const template = await w.template('ZZ_F505_正文', 'ZZ_F505_不可见文件');
  const started = await w.post(sourceId, [template.id]);
  expect(started.status).toBe(201);
  const { taskId } = await started.json();
  expect((await w.sign(w.employeeUser, await w.taskRow(taskId))).status).toBe(200);
  expect((await w.sign(w.userId, await w.taskRow(taskId))).status).toBe(200);
  await mount(w, {
    allowDownload: true,
    ...(mode === '服务端裁剪' ? { grants: { fields: { [RECORD]: ['scene'] } } } : { recordFields: ['scene'] }),
  });
  await click(control('已接受Offer'));
  await until(() => control('ZZ_F505_字段裁剪'), 'Offer 姓名入口加载');
  await click(control('ZZ_F505_字段裁剪'));
  const history = () => document.querySelector('section[aria-label="电子签署"]');
  await until(() => history()?.querySelector('tr[data-row-key]'), '来源详情真实读取签署历史');
  expect(history()?.textContent).toContain('Offer电子签署');
  expect(history()?.textContent).not.toMatch(/签署完成|下载文件|ZZ_F505_不可见文件/);
  expect(history()?.querySelector('a')).toBeNull();
});

it('AC-ESIGN-F505-FE-05 我的签署、签署记录与真实站内提醒展示相同的三场景标签', async () => {
  const w = await offerSigningWorld(db().db, 'FE05_SCENES');
  const template = await w.template();
  const tasks = [
    await w.transferFixture(template),
    await w.fixture('offer', template),
    await w.fixture('entry', template),
  ];
  for (const task of tasks) {
    expect((await w.action('remind', task)).status).toBe(200);
    expect((await w.sign(w.employeeUser, await w.taskRow(task.id))).status).toBe(200);
  }
  const labels = ['调动电子签署', 'Offer电子签署', '入职电子签署'];
  const notice = await w.call('GET', '/api/tenant/approval/notifications', { user: w.employeeUser });
  expect(notice.status).toBe(200);
  const { items } = await notice.json();
  for (const label of labels) expect(items.map((item: { body: string }) => item.body).join(' ')).toContain(label);
  const { RecordsPage } = await import(resolve('apps/web/src/esign/RecordsPage.tsx'));
  await mount(w, {}, RecordsPage);
  await until(
    () => labels.every((label) => text(document.querySelector('.esign-records')).includes(label)),
    '中央记录展示三场景',
  );
  const { MySignPage } = await import(resolve('apps/web/src/esign/MySignPage.tsx'));
  await mount(w, {}, MySignPage);
  await until(
    () => labels.every((label) => text(document.querySelector('.esign-mine')).includes(label)),
    '我的签署展示三场景',
  );
});

it('AC-ESIGN-F505-FE-05 第 2 页可见历史从 21 条降至 11 条时重读合法页', async () => {
  const database = db().db;
  const w = await offerSigningWorld(database, 'FE05_PAGE_SCOPE');
  const name = 'ZZ_F505_历史页码';
  const sourceId = await w.offer({ name });
  const hiddenOwner = await w.hire('ZZ_F505_范围外历史所有者');
  await w.template();
  await insertAnchor(database, w.tenantId, sourceId);
  const retainedIds: string[] = [];
  for (let index = 0; index < 21; index++) {
    const retained = index < 10;
    const id = await insertTask(database, w.tenantId, w.userId, {
      scene: 'offer',
      offerId: sourceId,
      employeeId: retained ? w.employeeId : hiddenOwner.employeeId,
      sourceRevision: 1,
      status: 'revoked',
    });
    if (retained) retainedIds.push(id);
  }

  const scopes: Record<string, ModuleScope> = {};
  const reads: { page: number; total: number; ids: string[] }[] = [];
  let createdTaskId: string | undefined;
  let releaseFirstPage: () => void = () => {};
  const holdFirstPage = new Promise<void>((resolve) => (releaseFirstPage = resolve));
  await mount(w, {
    grants: { scopes },
    intercept: async ({ method, path }, forward) => {
      const response = await forward();
      if (method === 'POST' && path === taskPath(sourceId) && response.status === 201) {
        const receipt = (await response.clone().json()) as { taskId: string };
        createdTaskId = receipt.taskId;
      }
      if (method === 'GET' && path.split('?')[0] === recordsPath(sourceId) && response.ok) {
        const result = (await response.clone().json()) as { page: number; total: number; items: { id: string }[] };
        reads.push({ page: result.page, total: result.total, ids: result.items.map(({ id }) => id) });
        if (result.page === 1 && result.total === 11) await holdFirstPage;
      }
      return response;
    },
  });
  const history = () => dialog()?.querySelector('section[aria-label="电子签署"]') ?? null;
  const rowIds = () =>
    Array.from(history()?.querySelectorAll('tr[data-row-key]') ?? [], (row) => row.getAttribute('data-row-key'));
  const pagination = () => history()?.querySelector('.ant-pagination');
  await openSign(name);
  await until(() => rowIds().length === 20, '第 1 页显示 20 条历史');
  expect(reads[0]).toMatchObject({ page: 1, total: 21 });
  await click(pagination()?.querySelector<HTMLElement>('.ant-pagination-item-2'));
  await until(
    () => rowIds().length === 1 && pagination()?.querySelector('.ant-pagination-item-active')?.textContent === '2',
    '第 2 页显示 1 条历史并保持选中',
  );
  expect(reads[1]).toMatchObject({ page: 2, total: 21 });

  scopes[RECORD] = { all: false, orgIds: [], personIds: [w.employeeId], hasDataPermission: true };
  try {
    await selectAll();
    await click(confirm());
    await until(
      () => reads.some(({ page, total }) => page === 2 && total === 11),
      '真实 201 后重读原第 2 页并得到收窄后的总数',
    );
    expect(createdTaskId).toEqual(expect.any(String));
    expect(reads.find(({ page, total }) => page === 2 && total === 11)?.ids).toEqual([]);
    const legalPage = () => reads.find(({ page, total }) => page === 1 && total === 11);
    await until(() => legalPage() || text(history()).includes('暂无可见签署记录'), '越界回复已处理');
    expect(text(history())).not.toContain('暂无可见签署记录');
    expect(text(history())).toContain('正在读取签署记录');
    expect(rowIds()).toEqual([]);
    expect(legalPage()?.ids).toHaveLength(11);
  } finally {
    await act(async () => releaseFirstPage());
  }

  await until(() => rowIds().length === 11, '合法页显示 11 条当前可见历史');
  expect(rowIds().sort()).toEqual([...retainedIds, createdTaskId].sort());
  expect(pagination()).toBeNull();
  expect(text(history())).not.toContain('暂无可见签署记录');
});
