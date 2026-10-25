import { test, expect } from './fixtures.js';
import {
  candidate,
  dateCreate,
  editor,
  fillCreate,
  openCreate,
  receipt,
  saveCreate,
  sent,
  setupCreate,
} from './intern-create-fixtures.js';

const profile = {
  backupMail: 'personal@example.com',
  mobilePhone: 'SYNTHETIC-PHONE',
  gender: 'female',
  birthday: '2003-02-04',
  engName: 'Synthetic Intern',
  idType: 'id_card',
  idNumber: 'SYNTHETIC-ID',
  dailyWageStandard: '123456789012.34',
  educationLevel: '合成本科',
  lastSchool: '合成大学',
  major: '合成专业',
  graduateDate: '2026-06-30',
};

test('AC-FE-R2d4-profile-01 新增全资料同一命令写入，裁剪回执正常完成', async ({ page }) => {
  const state = await setupCreate(page);
  const matches: unknown[] = [];
  await page.route('**/employment/rehire-matches', (route) => {
    matches.push(route.request().postDataJSON());
    return route.fulfill({ json: { matched: false } });
  });
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    state.saved = true;
    return route.fulfill({ status: 201, json: receipt({ profile: { backupMail: profile.backupMail } }) });
  });
  await openCreate(page);
  await fillCreate(page);
  for (const [label, value] of [
    ['个人邮箱', profile.backupMail],
    ['手机号码', profile.mobilePhone],
    ['性别', profile.gender],
    ['其他语言姓名', profile.engName],
    ['证件类型', profile.idType],
    ['证件号码', profile.idNumber],
    ['日工资标准', profile.dailyWageStandard],
    ['学历', profile.educationLevel],
    ['毕业学校', profile.lastSchool],
    ['专业', profile.major],
  ])
    await editor(page).getByLabel(label!, { exact: true }).fill(value!);
  await dateCreate(page, '出生日期', profile.birthday);
  await dateCreate(page, '毕业日期', profile.graduateDate);
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await expect(editor(page).getByText('未匹配到离职 / 退休人员')).toBeVisible();
  await editor(page).screenshot({ path: test.info().outputPath('intern-full-profile.png') });
  await saveCreate(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]!.body.profile).toEqual(profile);
  expect(state.requests[0]!.body.loginEmail).toBe('intern@example.com');
  expect(matches).toEqual([{ idType: profile.idType, idNumber: profile.idNumber }]);
  await expect(page.getByText('合成实习生', { exact: true })).toBeVisible();
});

test('AC-FE-R2d4-profile-02 重聘覆盖与清空只提交已提供字段，回执无 profile 仍完成', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/rehire-matches', (route) => route.fulfill({ json: { matched: true, candidate } }));
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    return route.fulfill({ status: 201, json: receipt({ kind: 'rehire' }) });
  });
  await openCreate(page);
  await fillCreate(page);
  await editor(page).getByLabel('个人邮箱', { exact: true }).fill('changed@example.com');
  await editor(page).getByLabel('其他语言姓名', { exact: true }).fill('清空测试');
  await editor(page).getByLabel('其他语言姓名', { exact: true }).fill('');
  await editor(page).getByLabel('证件号码', { exact: true }).fill(profile.idNumber);
  await editor(page)
    .getByRole('button', { name: /校\s*验/ })
    .click();
  await page
    .getByRole('dialog', { name: '重聘提示', exact: true })
    .getByRole('button', { name: '按重聘入职', exact: true })
    .click();
  await saveCreate(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]!.body.profile).toEqual({
    idType: 'id_card',
    idNumber: profile.idNumber,
    backupMail: 'changed@example.com',
    engName: null,
  });
  expect(state.requests[0]!.body.kind).toBe('rehire');
});

test('AC-FE-R2d4-profile-03 毕业日期单填与工资超精度阻止请求，修正后提交', async ({ page }) => {
  const state = await setupCreate(page);
  await openCreate(page);
  await fillCreate(page);
  await dateCreate(page, '毕业日期', profile.graduateDate);
  await saveCreate(page).click();
  await expect(editor(page).getByText('毕业日期须随学历、毕业学校或专业提供')).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await editor(page).getByLabel('专业', { exact: true }).fill('合成专业');
  await editor(page).getByLabel('日工资标准', { exact: true }).fill('250.123');
  await saveCreate(page).click();
  await expect(editor(page).getByText('日工资标准须为非负十进制数，整数最多 12 位，小数最多 2 位')).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await editor(page).getByLabel('日工资标准', { exact: true }).fill('250.12');
  await saveCreate(page).click();
  await expect(editor(page)).toHaveCount(0);
  expect(state.requests[0]!.body.profile).toEqual({
    major: '合成专业',
    graduateDate: profile.graduateDate,
    dailyWageStandard: '250.12',
  });
});

test('AC-FE-R2d4-profile-04 服务端字段无权整单拒绝，关闭重开保留输入并允许改正', async ({ page }) => {
  const state = await setupCreate(page);
  await page.route('**/employment/interns', (route) => {
    state.requests.push(sent(route.request()));
    return route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: '合成员工资料字段无编辑权' } } });
  });
  await openCreate(page);
  await fillCreate(page);
  await editor(page).getByLabel('个人邮箱', { exact: true }).fill('keep@example.com');
  await editor(page).getByLabel('日工资标准', { exact: true }).fill('0.00');
  await saveCreate(page).click();
  await expect(editor(page).getByText('合成员工资料字段无编辑权')).toBeVisible();
  await expect(saveCreate(page)).toBeEnabled();
  await editor(page)
    .getByRole('button', { name: /取\s*消/ })
    .click();
  await openCreate(page);
  await expect(editor(page).getByLabel('个人邮箱', { exact: true })).toHaveValue('keep@example.com');
  await expect(editor(page).getByLabel('日工资标准', { exact: true })).toHaveValue('0.00');
  expect(state.requests).toHaveLength(1);
  expect(state.saved).toBe(false);
});
