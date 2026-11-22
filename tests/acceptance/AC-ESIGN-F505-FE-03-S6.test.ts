import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { sql } from '@italent/db';
import { EMPLOYEE, offerSigningWorld } from './AC-ESIGN-F505-S4-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
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

it('AC-ESIGN-F505-FE-03 模板空、断网、权限拒绝分别呈现，选项错误不会成为空列表', async () => {
  const w = await offerSigningWorld(db().db, 'FE03_OPTIONS');
  await w.offer({ name: 'ZZ_F505_空', linkedEmployeeId: w.employeeId });
  await w.offer({ name: 'ZZ_F505_断网' });
  await w.offer({ name: 'ZZ_F505_权限' });
  let mode: 'empty' | 'offline' | 'forbidden' = 'empty';
  await mount(w, {
    grants: { deny: (q) => mode === 'forbidden' && q.resource === 'TenantBase.Offer' && q.action === 'object.update' },
    intercept: (request, forward) => {
      if (mode === 'offline' && request.path.endsWith('/esign-context')) return Promise.reject(new Error('offline'));
      return forward();
    },
  });
  await openSign('ZZ_F505_空');
  await until(() => text(dialog()).includes('暂无适用于本场景的启用模板'), '可用模板为空');
  expect(confirm()?.disabled).toBe(true);
  await click(control('取消', dialog()!));
  mode = 'offline';
  await openSign('ZZ_F505_断网');
  await until(() => text(dialog()).includes('签署模板读取失败'), '网络读取失败');
  expect(text(dialog())).not.toContain('暂无适用于本场景的启用模板');
  await click(control('取消', dialog()!));
  mode = 'forbidden';
  await openSign('ZZ_F505_权限');
  await until(() => text(dialog()).includes('无权'), '当前权限失效');
  expect(dialog()?.querySelector('select')).toBeNull();
});

it('AC-ESIGN-F505-FE-03 全选超过 20 保留完整选择并禁止提交，人员变量拒绝后可改选', async () => {
  const w = await offerSigningWorld(db().db, 'FE03_LIMIT');
  await w.offer({ name: 'ZZ_F505_上限' });
  const variable = await w.template('{员工姓名}', 'ZZ_F505_变量');
  for (let i = 1; i <= 20; i++) await w.template('ZZ_F505_静态', `ZZ_F505_模板_${i}`);
  const requests = await mount(w, { grants: { scopes: { [EMPLOYEE]: EMPTY_SCOPE } } });
  await openSign('ZZ_F505_上限');
  await until(() => dialog()?.querySelector('select option'), '模板加载');
  expect(confirm()?.disabled).toBe(true);
  expect(text(dialog())).toContain('使用提交时的模板内容');
  await selectAll();
  const picker = dialog()?.querySelector('select');
  expect(picker?.querySelectorAll('option')).toHaveLength(21);
  expect(confirm()?.disabled).toBe(true);
  expect(text(dialog())).toContain('一次最多选择20个模板');
  await actSelect([variable.id]);
  await click(confirm());
  await until(() => text(dialog()).includes('此模板需要相应人员字段权限'), '显示字段拒绝');
  expect(requests.filter(({ method }) => method === 'POST')).toHaveLength(1);
  expect(await w.taskCount()).toBe(0);
});

async function actSelect(ids: string[]) {
  const picker = dialog()!.querySelector('select')!;
  for (const option of picker.options) option.selected = ids.includes(option.value);
  const { act } = await import('./AC-ESIGN-F505-FE-S6-support.js');
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
}

it('AC-ESIGN-F505-FE-03 真实 201 失败任务显示发起失败及原因，来源历史按权限独立读取', async () => {
  const w = await offerSigningWorld(db().db, 'FE03_FAILED');
  await w.offer({ name: 'ZZ_F505_任务失败' });
  await w.template();
  await w.inTenant((tx) =>
    tx.execute(sql`
    UPDATE tenant_memberships SET status='revoked' WHERE tenant_id=${w.tenantId} AND user_id=${w.employeeUser}
  `),
  );
  const requests = await mount(w);
  await openSign('ZZ_F505_任务失败');
  await until(() => text(dialog()).includes('暂无可见签署记录'), '历史为空');
  await selectAll();
  await click(confirm());
  await until(() => text(dialog()).includes('发起失败'), '失败任务状态可见');
  expect(text(dialog())).toMatch(/账号/);
  expect(text(dialog())).not.toContain('已发起签署');
  expect(requests.some(({ path }) => path.includes('/esign/mine/'))).toBe(true);
  expect(requests.filter(({ path }) => path.includes('/esign-records')).length).toBeGreaterThan(1);
});

it('AC-ESIGN-F505-FE-03 有发起权限、无设置及签署记录查看权，仍可发起并读取自己的任务', async () => {
  const w = await offerSigningWorld(db().db, 'FE03_NO_CONFIG');
  await w.offer({ name: 'ZZ_F505_可发起' });
  await w.template();
  const requests = await mount(w, {
    records: false,
    grants: { deny: (q) => q.resource === 'TenantBase.ESignSettings' },
  });
  await openSign('ZZ_F505_可发起');
  await selectAll();
  await click(confirm());
  await until(() => text(dialog()).includes('待本人签署'), '发起人可查看自己的任务');
  expect(text(dialog())).not.toContain('暂无可见签署记录');
  expect(requests.some(({ path }) => path.includes('/esign/mine/'))).toBe(true);
});
