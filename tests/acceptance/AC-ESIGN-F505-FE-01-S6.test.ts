import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { offerSigningWorld } from './AC-ESIGN-F505-S4-support.js';
import { click, control, dialog, mount, openMenu, openSign, text, until } from './AC-ESIGN-F505-FE-S6-support.js';

const db = useTestDb();

it('FE-01 只启用真实列表返回的发起动作，状态和版本不参与前端判断', async () => {
  const w = await offerSigningWorld(db().db, 'FE01');
  await w.offer({ name: 'ZZ_F505_已接受', linkedEmployeeId: null });
  await w.offer({ name: 'ZZ_F505_已入职', status: 'onboarded' });
  await w.offer({ name: 'ZZ_F505_已发', status: 'sent' });
  const requests = await mount(w);
  await openSign('ZZ_F505_已接受');
  await until(() => text(dialog()).includes('尚无可用于签署的人员关联'), '明确显示来源条件不满足');
  expect(requests.filter(({ method }) => method === 'POST')).toEqual([]);
  await click(control('取消', dialog()!));
  await openMenu('ZZ_F505_已发', '已发Offer');
  expect(control('发起电子签署')).toBeUndefined();
  await openSign('ZZ_F505_已入职', '已入职Offer');
});
