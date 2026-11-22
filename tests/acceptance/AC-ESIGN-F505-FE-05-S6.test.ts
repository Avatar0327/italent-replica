import { resolve } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { offerSigningWorld } from './AC-ESIGN-F505-S4-support.js';
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
  await until(() => row('调动电子签署'), '调动配置加载');
  expect(row('Offer电子签署')?.textContent ?? '', '同表显示 Offer 场景及其独立读值').toContain('13 天');
  expect(row('入职电子签署')?.textContent).toContain('2 天');
  expect(row('调动电子签署')?.textContent).toContain('2 天');
  await click(control('编辑', row('Offer电子签署')!));
  expect(document.querySelector('.ant-drawer')?.textContent).toContain('Offer电子签署');
});

it('FE-05 我的签署及记录采用与站内通知一致的场景名，陌生值使用受控文案', () => {
  expect(['transfer', 'offer', 'entry'].map(sceneText)).toEqual(['调动电子签署', 'Offer电子签署', '入职电子签署']);
  expect(sceneText('constructor')).toBe('无法识别的签署场景');
  expect(sceneText(undefined)).toBe('--');
});
