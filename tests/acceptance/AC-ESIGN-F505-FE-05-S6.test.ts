import { resolve } from 'node:path';
import { ESIGN_REMIND_TEMPLATE, renderEsignNotice } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { RECORD, offerSigningWorld } from './AC-ESIGN-F505-S4-support.js';
import { click, control, mount, row, text, until } from './AC-ESIGN-F505-FE-S6-support.js';

const { ScenesPage } = await import(resolve('apps/web/src/esign/ScenesPage.tsx'));
const { sceneText } = await import(resolve('apps/web/src/esign/sign-model.ts'));
const db = useTestDb();

it('FE-05 场景设置从三个真实读口取得各自配置', async () => {
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

it('FE-05 我的签署及记录采用与站内通知一致的场景名，陌生值使用受控文案', () => {
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

it('FE-05 我的签署、签署记录与真实站内提醒展示相同的三场景标签', async () => {
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
