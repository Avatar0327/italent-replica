/// <reference lib="dom" />
// @vitest-environment happy-dom
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, h, permission, uiHarness } from './support/f474-ui.js';
const { JobEditor } = await import(resolve('apps/web/src/job/JobEditor.tsx'));
const { jobFormGroups, jobPermissionField } = await import(resolve('apps/web/src/job/page-model.ts'));
const { pageAccess } = await import(resolve('apps/web/src/org/page-model.ts'));
const { FormOverlay } = await import(resolve('apps/web/src/foundation/FormOverlay.tsx'));
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());

const requiredLabels: Record<string, string[]> = {
  sequences: ['名称', '生效日期', '状态'],
  'level-types': ['名称', '生效日期'],
  grades: ['名称', '等级', '生效日期', '状态'],
  levels: ['名称', '职级类别', '级别', '生效日期'],
  posts: ['编码', '名称', '设立日期', '职务序列'],
  positions: ['编码', '名称', '设立日期', '所属组织'],
};
it.each(Object.entries(requiredLabels))('AC-JOB F474 %s 新建逐字段核对红星，非必填项不多标', async (kind, required) => {
  const fields = jobFormGroups(kind)
    .flatMap((group: { fields: string[] }) => group.fields)
    .map(jobPermissionField);
  await ui.render(
    h(JobEditor, {
      kind,
      date: '2026-11-03',
      today: '2026-11-03',
      access: pageAccess(permission(fields)),
      onClose() {},
      onSaved() {},
    }),
    '/',
    fields,
  );
  const labels = Array.from(document.querySelectorAll('[role="dialog"] .ant-form-item-label label'));
  expect(labels.length).toBeGreaterThan(3);
  for (const label of labels) {
    expect
      .soft(label.classList.contains('ant-form-item-required'), label.textContent ?? '')
      .toBe(required.includes(label.textContent ?? ''));
  }
  expect(
    labels.filter((label) => label.classList.contains('ant-form-item-required')).map((label) => label.textContent),
  ).toEqual(required);
});
it('AC-JOB F474 被查看权隐藏的必填字段不留红星或标签', async () => {
  await ui.render(
    h(JobEditor, {
      kind: 'grades',
      date: '2026-11-03',
      today: '2026-11-03',
      access: pageAccess(permission(['name', 'layerId'])),
      onClose() {},
      onSaved() {},
    }),
  );
  const labels = Array.from(document.querySelectorAll('[role="dialog"] .ant-form-item-label label'));
  expect(labels.map((label) => label.textContent)).toEqual(['名称', '职层']);
  expect(
    labels.filter((label) => label.classList.contains('ant-form-item-required')).map((label) => label.textContent),
  ).toEqual(['名称']);
});

it.each([true, false, undefined])('AC-JOB F474 呈现标记 %s 不替换已有必填校验', async (requiredMark) => {
  const submit = vi.fn();
  await ui.render(
    h(FormOverlay, {
      open: true,
      title: '合成表单',
      recordKey: 'marker-validation',
      onClose() {},
      onSubmit: submit,
      groups: [
        {
          title: '字段',
          fields: [
            {
              name: 'name',
              label: '名称',
              control: h('input'),
              access: { visible: true, editable: true },
              requiredMark,
              rules: [{ required: true, message: '既有必填校验' }],
            },
          ],
        },
      ],
    }),
  );
  expect(document.querySelector('.ant-form-item-label label')?.classList.contains('ant-form-item-required')).toBe(
    requiredMark ?? true,
  );
  await act(async () =>
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.replace(/\s/g, '') === '保存')!
      .click(),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(submit).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('既有必填校验');
});
it('AC-JOB F474 仅呈现红星不新增保存规则，只读标记也不扩大提交字段', async () => {
  const submit = vi.fn();
  await ui.render(
    h(FormOverlay, {
      open: true,
      title: '合成表单',
      recordKey: 'marker-only',
      onClose() {},
      onSubmit: submit,
      initialValues: { date: '2026-11-03', hidden: '不可见' },
      groups: [
        {
          title: '字段',
          fields: [
            {
              name: 'grade',
              label: '等级',
              control: h('input'),
              access: { visible: true, editable: true },
              requiredMark: true,
            },
            {
              name: 'date',
              label: '日期',
              control: null,
              access: { visible: true, editable: false },
              requiredMark: true,
            },
            {
              name: 'hidden',
              label: '隐藏',
              control: null,
              access: { visible: false, editable: false },
              requiredMark: true,
            },
          ],
        },
      ],
    }),
  );
  expect(Array.from(document.querySelectorAll('.ant-form-item-required')).map((label) => label.textContent)).toEqual([
    '等级',
    '日期',
  ]);
  await act(async () =>
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.replace(/\s/g, '') === '保存')!
      .click(),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(submit).toHaveBeenCalledWith({ grade: undefined });
});
