// F-142（DEC-502②③）：已接入内核的页面不绕过内核。
// 一、静态：页面目录里不再留字段投影、重读回填、恢复槽键、命令存储的重复实现；
// 二、运行：每个页面至少一条冒烟用例走内核路径（冲突重读或结果未知锁定），这里核对用例仍在。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve('apps/web/src');
const SMOKE = resolve('apps/web/smoke');
const pages = ['succession', 'idp', 'contracts', 'org', 'job', 'evaluation', 'survey360'] as const;
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
const sources = (dir: string) =>
  readdirSync(join(SRC, dir))
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({ file: `${dir}/${name}`, text: read(`${dir}/${name}`) }));
const pageSources = pages.flatMap(sources);
const offenders = (pattern: RegExp, allowed: readonly string[] = []) =>
  pageSources.filter(({ file, text }) => pattern.test(text) && !allowed.includes(file)).map(({ file }) => file);

describe('AC-FE-F142 页面不留重复实现', () => {
  it('命令存储只经内核 useCommandForm：页面不自己订阅存储、不自己按会话拼键', () => {
    expect(offenders(/useSyncExternalStore/)).toEqual([]);
    expect(offenders(/JSON\.stringify\(\[session\.tenantId/)).toEqual([]);
    // 合同的模块级存储只交给 useCommandForm(resource, store)；评定旧创建兼容层只剩测试引用（AC-FE-R3b-rework）。
    expect(offenders(/createFormStore\(/, ['contracts/commands.ts', 'evaluation/create-commands.ts'])).toEqual([]);
    expect(read('contracts/commands.ts')).toMatch(/useCommandForm\(resource, store\)/);
  });
  it('字段投影走 projectFields：页面不再按字段 ?? null 自拼投影', () => {
    expect(offenders(/\.map\(\((\w+)\) => \[\1, [^;\n]*\?\? null\]\)/)).toEqual([]);
    for (const file of ['contracts/recovery.tsx', 'contracts/forms.ts', 'contracts/ContractForm.tsx'])
      expect(read(file), file).toMatch(/projectFields\(/);
  });
  it('重读回填走 refillDraft / useDraftRefill：页面不留 rereadDraft，表单不直接回填内核草稿', () => {
    expect(offenders(/rereadDraft/)).toEqual([]);
    expect(offenders(/setFieldsValue\(\w+\.state\.values\)/)).toEqual([]);
    // 两个接入点都把命令对象交给 useDraftRefill（只读回填同步内核草稿，F-142 第 2 轮 P2），不只交 state。
    expect(read('foundation/FormOverlay.tsx')).toMatch(/useDraftRefill\(submission,/);
    expect(read('evaluation/ActivityWizard.tsx')).toMatch(/useDraftRefill\(\s*writer,/);
  });
  it('恢复槽键走 slotKey，上下文存进内核槽，不再塞进表单值', () => {
    expect(offenders(/__context/)).toEqual([]);
    expect(read('org/record-command.ts')).toMatch(/slotContext/);
    expect(read('org/record-command.ts')).not.toMatch(/function slotContext/);
    expect(read('org/OrgEditor.tsx')).toMatch(/resource: slotKey\(/);
    expect(read('org/page-model.ts')).toMatch(/orgCreateResource = slotKey\(/);
    expect(read('job/JobEditor.tsx')).toMatch(/resource: slotKey\(/);
    expect(read('evaluation/useRecordForm.ts')).toMatch(/useCommandForm\(slotKey\(/);
    expect(read('evaluation/CreateEntry.tsx')).toMatch(/useCommandForm\(slotKey\(/);
  });
  it('ConflictCommands 只在内核里实现：继任页面只留删除按钮', () => {
    expect(offenders(/createContext/)).toEqual([]);
    const succession = sources('succession').filter(({ text }) => /useConflictCommand|ConflictCommands/.test(text));
    for (const { file, text } of succession)
      if (file !== 'succession/conflict.tsx') expect(text, file).toMatch(/foundation\/forms\/ConflictCommands\.js/);
    expect(read('succession/conflict.tsx')).not.toMatch(/export function useConflictCommand/);
  });
});

// 每个页面至少一条走内核路径的冒烟用例（冲突重读 / 结果未知锁定）。
const smokes: Record<(typeof pages)[number], string[]> = {
  succession: [
    'AC-FE-R3d1-18 编辑继任冲突后重读：只发改过的字段，版本取最新',
    'AC-FE-R3d1-25 编辑继任结果未知：关闭刷新后行带新版本，重开仍锁定，不发第二个 PUT',
    'AC-FE-R3d1-20 继任记录删除冲突：自动刷新列表，重选后按新版本删除',
  ],
  idp: [
    'AC-FE-R3d2-22 两次冲突、子流程先缺字段后恢复且服务端新增阶段：确认后显示最新两条，只改名称不提交子流程',
    'AC-FE-R3d2-15 冲突后重读缺 revision：不解锁、不发 If-Match: 0，提示重读失败',
    'AC-FE-F164-06 回顾保存冲突：重读最新版本、核对差异后带新版本重提，保留我的输入',
    'AC-FE-F164-07 回顾保存结果未知：表单锁定，回查原单后仍锁定，不发第二次 PUT',
  ],
  contracts: [
    'AC-FE-R2a-12 ${cases[op].title}：版本冲突保留输入，重读核对后带新版本重提',
    'AC-FE-R2a-30 新建规则结果未知后切换子页再回来：仍锁定，同内容不再发第二次 POST',
  ],
  org: [
    'AC-FE-R1a-08 组织变更显式联动；冲突后重读、核对差异再提交，不盲重放',
    'AC-FE-R1a-35 新建结果未知后换入口、换日期仍锁定，只发 1 次 POST',
    'AC-FE-R1a-37 组织变更结果未知后换列表日期、换动作重开，仍锁定且只发 1 次 PATCH',
  ],
  job: [
    'AC-FE-R1a-27 职务编辑冲突：重读最新版本保留草稿并回填未改字段，核对后只再发一条命令',
    'AC-FE-R1a-37 职务编辑结果未知后换列表日期重开，仍锁定且只发 1 次 PATCH',
  ],
  evaluation: [
    "AC-FE-F123-R2 评定重读${completed ? '完成' : '有报名'}后只读字段使用最新记录",
    'AC-FE-R3b-R2-01 评定新建共用结果未知保护',
  ],
  survey360: [
    'AC-FE-F123-R2 360 冲突重读启用后只读评价形式显示最新值、可编辑名称保留草稿',
    'AC-FE-R3b-R2-01 360 结果未知关闭重开及切换页签不能生成第二个创建命令',
  ],
};

describe('AC-FE-F142 每个接入页面都有走内核路径的冒烟用例', () => {
  const titles = readdirSync(SMOKE)
    .filter((name) => name.endsWith('.smoke.spec.ts'))
    .map((name) => readFileSync(join(SMOKE, name), 'utf8'))
    .join('\n');
  it.each(pages)('%s', (page) => {
    expect(smokes[page].length).toBeGreaterThan(0);
    for (const title of smokes[page]) expect(titles, title).toContain(title);
  });
});
