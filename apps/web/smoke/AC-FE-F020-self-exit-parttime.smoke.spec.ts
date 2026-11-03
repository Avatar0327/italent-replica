import { test, expect, employee, tenant, selfServiceButtons } from './fixtures.js';
const id = '50000000-0000-4000-8000-000000000020';
const department = '60000000-0000-4000-8000-000000000020';
const base = '/api/tenant/self-service';
const kinds = ['exit', 'partTime'] as const;
const titles = { exit: '本人离职', partTime: '新增兼职' };
for (const kind of kinds)
  for (const recovery of [false, true]) {
    test(`AC-FE-F020 ${kind} 创建、暂存、提交、我的申请与审批进度${recovery ? '（409与未知重放）' : ''}`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: 'italent_demo_tenant', value: tenant, url: baseURL! }]);
      const path = `${base}/${kind === 'exit' ? 'exit' : 'part-time'}-requests`;
      const modes =
        kind === 'exit'
          ? { lastWorkDate: 'editable', reasonCode: 'editable', whereaboutsCode: 'editable' }
          : {
              partTimeType: 'editable',
              effectiveDate: 'editable',
              endDate: 'editable',
              departmentId: 'editable',
              directManagerId: 'editable',
              requestRemark: 'editable',
              postId: 'readonly',
            };
      let row: Record<string, unknown> = {};
      let employeeRevision = 7;
      const conflicts = new Set<string>();
      const receipts = new Map<string, Record<string, unknown>>();
      const writes: { path: string; body: Record<string, unknown>; revision?: string; key?: string }[] = [];
      await page.route('**/api/tenant/**', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        let result: unknown;
        if (url.pathname === `${base}/profile`)
          result = {
            employee: { id: employee, name: '合成本人', code: 'DEMO-F020', revision: employeeRevision },
            timezone: 'Asia/Shanghai',
            today: '2026-11-03',
            record: null,
            selfServiceButtons: [
              ...selfServiceButtons,
              ...['Exit.Self', 'PartTime.Self'].map((buttonCode) => ({ buttonCode, level: 'detail' })),
            ],
          };
        else if (url.pathname === `${path}/form`)
          result = {
            employee: { id: employee, name: '合成本人', code: 'DEMO-F020', revision: employeeRevision },
            dataOperations: { create: true, update: true },
            fieldModes: modes,
            updateFieldModes: modes,
            values: kind === 'exit' ? { reasonCode: 'personal' } : {},
          };
        else if (url.pathname === `${path}/references/departmentId`)
          result = {
            items: [
              { id: tenant, name: '合成根', parentId: null, selectable: false },
              { id: department, name: '合成兼职部门', parentId: tenant, selectable: true },
            ],
          };
        else if (url.pathname === `${path}/references/directManagerId`) result = { items: [] };
        else if (url.pathname.startsWith(path) && req.method() !== 'GET') {
          const body = req.postDataJSON() as Record<string, unknown>;
          writes.push({
            path: url.pathname,
            body,
            revision: req.headers()['if-match'],
            key: req.headers()['idempotency-key'],
          });
          const action = url.pathname === path ? 'create' : url.pathname.endsWith('/submit') ? 'submit' : 'edit';
          const key = req.headers()['idempotency-key']!;
          if (receipts.has(key))
            return route.fulfill({ status: action === 'create' ? 201 : 200, json: receipts.get(key) });
          if (recovery && !conflicts.has(action)) {
            conflicts.add(action);
            if (action === 'create') employeeRevision++;
            else if (kind === 'exit' && !recovery && url.pathname === path && !body.pendingTransferAck)
              return route.fulfill({
                status: 409,
                json: {
                  error: {
                    code: 'CONFLICT',
                    message: '存在在途调动，请确认',
                    details: { reason: 'EXIT_PENDING_TRANSFER_ACK_REQUIRED', ackToken: 'synthetic-confirmation' },
                  },
                },
              });
            row = {
              ...row,
              revision: Number(row.revision) + 1,
              ...(action === 'edit' ? { [kind === 'exit' ? 'lastWorkDate' : 'endDate']: '2026-12-03' } : {}),
            };
            return route.fulfill({
              status: 409,
              json: { error: { code: 'REVISION_CONFLICT', message: '请核对最新版本' } },
            });
          }
          row = {
            ...row,
            ...body,
            id,
            employeeId: employee,
            employeeRevision: 7,
            revision: Number(row.revision ?? 0) + 1,
            status: url.pathname.endsWith('/submit') ? 'in_review' : 'draft',
            kind: kind === 'exit' ? 'exit' : 'add',
            fields: body.fields ?? row.fields ?? {},
            ...(kind === 'partTime'
              ? {
                  serviceType: body.partTimeType ?? row.serviceType,
                  effectiveDate: body.startDate ?? row.effectiveDate,
                }
              : {}),
          };
          delete row.partTimeType;
          delete row.startDate;
          receipts.set(key, structuredClone(row));
          if (recovery) return route.abort('failed');
          return route.fulfill({ status: url.pathname === path ? 201 : 200, json: row });
        } else if (url.pathname === `${path}/${id}`) result = row;
        else if (url.pathname === `${base}/applications`)
          result = {
            items:
              row.status === 'in_review'
                ? [
                    {
                      id,
                      businessId: id,
                      revision: row.revision,
                      title: titles[kind],
                      category: titles[kind],
                      applicationKind: kind,
                      initiator: '合成本人',
                      currentHandlers: ['合成审批人'],
                      status: '审批中',
                      createdAt: '2026-11-03T01:00:00Z',
                    },
                  ]
                : [],
            page: 1,
            pageSize: 15,
          };
        else if (url.pathname === `${base}/applications/${id}`) result = { status: '审批中', record: row };
        else if (url.pathname === `/api/tenant/approval/instances/${id}`)
          result = {
            id,
            revision: 1,
            title: titles[kind],
            status: 'running',
            approvalType: kind === 'exit' ? 'leave' : 'part_time_add',
            actions: [],
            form: { values: {} },
            recordsHidden: false,
            logs: [],
            tasks: [{ id, nodeName: '合成审批节点', status: 'pending' }],
          };
        return result === undefined ? route.fallback() : route.fulfill({ json: result });
      });
      await page.goto('/self/applications');
      await expect(page.getByRole('button', { name: '本人离职', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: '新增兼职', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: titles[kind], exact: true }).click();
      await expect(page.getByText('合成本人', { exact: false }).last()).toBeVisible();
      await expect(page.getByLabel('选择人员')).toHaveCount(0);
      if (kind === 'exit') {
        await expect(page.getByText('个人原因', { exact: true })).toBeVisible();
        await page.getByLabel('日期').fill('2026-12-01');
        await page.getByLabel('日期').press('Enter');
      } else {
        await page.getByRole('combobox', { name: '兼职类型', exact: true }).click();
        await page.getByText('借调', { exact: true }).click();
        await page.getByLabel('开始日期', { exact: true }).fill('2026-12-01');
        await page.getByRole('combobox', { name: '兼职部门', exact: true }).click();
        await page.getByText('合成兼职部门', { exact: true }).click();
      }
      await page.getByRole('button', { name: /^暂\s*存$/ }).click();
      if (kind === 'exit' && !recovery)
        await page
          .getByRole('dialog')
          .getByRole('button', { name: /^确\s*认$/ })
          .click();
      if (recovery) {
        await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
        await page.getByRole('button', { name: /^暂\s*存$/ }).click();
        await expect(page.getByRole('button', { name: '回查并重放原命令' })).toBeVisible();
        await page.getByRole('link', { name: '返回人事申请' }).click();
        await page.goBack();
        await expect(page.getByRole('button', { name: /^暂\s*存$/ })).toBeDisabled();
        await page.getByRole('button', { name: '回查并重放原命令' }).click();
      }
      await expect(page).toHaveURL(new RegExp(`/self/${kind}/${id}$`));
      if (recovery) {
        const date = kind === 'exit' ? page.getByLabel('日期') : page.getByLabel('结束日期', { exact: true });
        await date.fill('2026-12-02');
        if (kind === 'exit') await date.press('Enter');
        await expect(page.getByRole('button', { name: '提交审批' })).toBeDisabled();
        await page.getByRole('button', { name: /^暂\s*存$/ }).click();
        await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
        await date.fill(kind === 'exit' ? '2026-12-01' : '');
        if (kind === 'exit') await date.press('Enter');
        await page.getByRole('button', { name: /^暂\s*存$/ }).click();
        await page.getByRole('button', { name: '回查并重放原命令' }).click();
        await expect(page.getByRole('button', { name: '提交审批' })).toBeEnabled();
        expect(writes.filter((w) => w.path === `${path}/${id}`).at(-1)?.body).toEqual(
          kind === 'exit' ? { lastWorkDate: '2026-12-01' } : { endDate: null },
        );
      }
      await page.getByRole('button', { name: '提交审批', exact: true }).click();
      if (recovery) {
        await page.getByRole('button', { name: '已核对差异，继续编辑', exact: true }).click();
        await page.getByRole('button', { name: '提交审批', exact: true }).click();
        await page.getByRole('button', { name: '回查并重放原命令' }).click();
        await expect(page).toHaveURL(/\/self\/requests$/);
        for (const target of [path, `${path}/${id}`, `${path}/${id}/submit`]) {
          const attempts = writes.filter((w) => w.path === target);
          expect(attempts).toHaveLength(3);
          expect(attempts[1]).toEqual(attempts[2]);
          expect(attempts[1]!.key).not.toBe(attempts[0]!.key);
          expect(Number(attempts[1]!.revision)).toBeGreaterThan(Number(attempts[0]!.revision));
        }
      }
      await expect(page).toHaveURL(/\/self\/requests$/);
      await page.getByRole('button', { name: titles[kind], exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('审批中');
      await page.getByRole('tab', { name: '审批进度', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('合成审批节点');
      expect(writes[0]?.revision).toBe('7');
      expect(writes.at(-1)?.revision).toBe(recovery ? '4' : '1');
      expect(writes.every((write) => !!write.key)).toBe(true);
      expect(writes[0]?.body).not.toHaveProperty('employeeId');
      if (kind === 'partTime')
        expect(writes[0]?.body).toMatchObject({
          partTimeType: 'secondment',
          startDate: '2026-12-01',
          fields: { departmentId: department },
        });
    });
  }
test('AC-FE-F020 无对应按钮隐藏入口，直接访问拒绝', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'italent_demo_tenant', value: tenant, url: baseURL! }]);
  await page.goto('/self/applications');
  await expect(page.locator('.shell-workspace .ant-table')).toBeVisible();
  await expect(page.getByRole('button', { name: '本人离职', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新增兼职', exact: true })).toHaveCount(0);
  for (const kind of kinds) {
    await page.goto(`/self/${kind}/new`);
    await expect(page.locator('.shell-workspace')).toContainText('暂无访问权限');
  }
});
for (const kind of kinds) {
  test(`AC-FE-F020 ${kind} 已驳回编辑态按修改字段权，隐藏字段不渲染`, async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'italent_demo_tenant', value: tenant, url: baseURL! }]);
    const field = kind === 'exit' ? 'lastWorkDate' : 'endDate';
    let editable = true;
    await page.route('**/api/tenant/self-service/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/profile'))
        return route.fulfill({
          json: {
            employee: { id: employee, name: '合成本人', revision: 7 },
            timezone: 'Asia/Shanghai',
            today: '2026-11-03',
            record: null,
            selfServiceButtons: [{ buttonCode: kind === 'exit' ? 'Exit.Self' : 'PartTime.Self', level: 'detail' }],
          },
        });
      if (path.endsWith('/form'))
        return route.fulfill({
          json: {
            employee: { id: employee, name: '合成本人', code: 'DEMO-F020', revision: 7 },
            dataOperations: { create: false, update: true },
            fieldModes: { [field]: 'readonly' },
            updateFieldModes: { [field]: editable ? 'editable' : 'readonly' },
            values: {},
          },
        });
      return route.fulfill({
        json: { id, employeeId: employee, revision: 1, status: 'rejected', fields: {}, [field]: '2026-12-01' },
      });
    });
    await page.goto(`/self/${kind}/${id}`);
    const control = kind === 'exit' ? page.getByLabel('日期') : page.getByLabel('结束日期', { exact: true });
    await expect(control).toBeEditable();
    await expect(page.getByRole('combobox', { name: '离职原因', exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '兼职部门', exact: true })).toHaveCount(0);
    editable = false;
    await page.reload();
    if (kind === 'exit') await expect(control).toBeDisabled();
    else {
      await expect(page.getByText('2026-12-01', { exact: true })).toBeVisible();
      await expect(control).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^暂\s*存$/ })).toBeEnabled();
  });
}
