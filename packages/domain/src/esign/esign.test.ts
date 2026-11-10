import { describe, expect, it } from 'vitest';
import {
  ESIGN_COMPLETED_EMPLOYEE_TEMPLATE,
  ESIGN_COMPLETED_INITIATOR_TEMPLATE,
  ESIGN_FAILURE_COPY,
  ESIGN_NOTICE_TEMPLATES,
  ESIGN_REMIND_TEMPLATE,
  ESIGN_REVOKED_EMPLOYEE_TEMPLATE,
  ESIGN_REVOKED_INITIATOR_TEMPLATE,
  ESIGN_TEMPLATE_VARIABLES,
  esignExpiresAt,
  esignFailureText,
  esignFileLabel,
  isTerminal,
  isValidValidityDays,
  nextSignState,
  renderEsignNotice,
  renderTemplateBody,
  unknownTemplateVariables,
  type SignEvent,
  type SignStatus,
} from './index.js';

const at = new Date('2026-11-30T02:00:00.000Z');
const employeeSigned: SignEvent = { type: 'node_signed', node: 'employee', actorUserId: null, at };
const enterpriseSigned: SignEvent = { type: 'node_signed', node: 'enterprise', actorUserId: null, at };
const revoked: SignEvent = { type: 'revoked', cause: 'manual', actorUserId: null, at };
const expired: SignEvent = { type: 'expired', at };
const failed: SignEvent = { type: 'provider_failed', reason: 'X', at };

describe('F-481 状态迁移表（设计 §6.3）', () => {
  it('员工确认 → 仍在签署中，轮到企业节点；企业确认 → 完成且无当前节点', () => {
    expect(nextSignState({ status: 'signing', currentNode: 'employee' }, employeeSigned)).toEqual({
      ok: true,
      status: 'signing',
      currentNode: 'enterprise',
    });
    expect(nextSignState({ status: 'signing', currentNode: 'enterprise' }, enterpriseSigned)).toEqual({
      ok: true,
      status: 'completed',
      currentNode: null,
    });
  });

  it('节点不对（员工节点上签企业、企业节点上签员工）拒绝，不改状态', () => {
    expect(nextSignState({ status: 'signing', currentNode: 'employee' }, enterpriseSigned)).toEqual({
      ok: false,
      reason: 'ESIGN_NODE_MISMATCH',
    });
    expect(nextSignState({ status: 'signing', currentNode: 'enterprise' }, employeeSigned)).toEqual({
      ok: false,
      reason: 'ESIGN_NODE_MISMATCH',
    });
  });

  it('签署中的任务在任一节点都可撤销、到期、被服务方置失败，终态没有当前节点', () => {
    for (const currentNode of ['employee', 'enterprise'] as const) {
      const task = { status: 'signing', currentNode } as const;
      expect(nextSignState(task, revoked)).toEqual({ ok: true, status: 'revoked', currentNode: null });
      expect(nextSignState(task, expired)).toEqual({ ok: true, status: 'expired', currentNode: null });
      expect(nextSignState(task, failed)).toEqual({ ok: true, status: 'failed', currentNode: null });
    }
  });

  it('终态吸收：completed / revoked / expired / failed 对任何事件都拒绝 ESIGN_TASK_CLOSED', () => {
    const terminals: SignStatus[] = ['completed', 'revoked', 'expired', 'failed'];
    for (const status of terminals) {
      expect(isTerminal(status)).toBe(true);
      for (const event of [employeeSigned, enterpriseSigned, revoked, expired, failed]) {
        expect(nextSignState({ status, currentNode: null }, event)).toEqual({ ok: false, reason: 'ESIGN_TASK_CLOSED' });
      }
    }
    expect(isTerminal('signing')).toBe(false);
  });
});

describe('F-481 失败原因文案（设计 §4.4）', () => {
  it('四个原因各有固定文案；目录外的原因不泄露原文', () => {
    expect(ESIGN_FAILURE_COPY).toEqual({
      TEMPLATE_UNAVAILABLE: '所选签署模板已停用',
      EMPLOYEE_NO_ACCOUNT: '员工没有可登录的账号，无法签署',
      INITIATOR_NO_ACCOUNT: '签署发起人账号不可用，无法完成企业确认',
      RENDER_FAILED: '签署文件生成失败',
    });
    expect(esignFailureText('RENDER_FAILED')).toBe('签署文件生成失败');
    expect(esignFailureText(null)).toBeNull();
    expect(esignFailureText('PROVIDER_SECRET_DETAIL')).toBe('签署发起失败');
  });
});

describe('F-481 模板变量（设计 §3.3）', () => {
  it('变量表共 11 个，与设计一致', () => {
    expect([...ESIGN_TEMPLATE_VARIABLES]).toEqual([
      '员工姓名',
      '工号',
      '调动生效日期',
      '调出部门',
      '调出职位',
      '调入部门',
      '调入职位',
      '新合同开始日期',
      '新合同结束日期',
      '发起日期',
      '企业名称',
    ]);
  });

  it('找出表外变量（去重、保持顺序）；全部合法返回空数组', () => {
    expect(unknownTemplateVariables('{员工姓名}与{不存在的变量}及{另一个}再{不存在的变量}')).toEqual([
      '不存在的变量',
      '另一个',
    ]);
    expect(unknownTemplateVariables('没有变量的正文 {员工姓名} {企业名称}')).toEqual([]);
    expect(unknownTemplateVariables('{}')).toEqual(['']);
  });

  it('替换：空工号、缺合同日期显示“--”；其余原样', () => {
    const text = renderTemplateBody('{员工姓名}（工号 {工号}）新合同 {新合同开始日期}～{新合同结束日期}', {
      员工姓名: '合成员工',
      工号: '',
      新合同开始日期: null,
    });
    expect(text).toBe('合成员工（工号 --）新合同 --～--');
  });

  it('替换时遇到表外变量抛错（保存时已拦截，这里是 RENDER_FAILED 的保底）', () => {
    expect(() => renderTemplateBody('{不存在的变量}', {})).toThrow('不存在的变量');
  });
});

describe('F-481 站内消息模板（设计 §7）', () => {
  it('五个模板码、标题与正文与设计一致', () => {
    const copy = (code: string) => [ESIGN_NOTICE_TEMPLATES[code]!.title, ESIGN_NOTICE_TEMPLATES[code]!.body];
    expect(copy(ESIGN_REMIND_TEMPLATE)).toEqual([
      '电子签署提醒',
      '您有一份{场景}待签署：{文件名称}，请在 {截止时间} 前到「我的签署」完成签署。',
    ]);
    expect(copy(ESIGN_REVOKED_INITIATOR_TEMPLATE)).toEqual([
      '电子签署已撤销',
      '{员工姓名}的{场景}（{文件名称}）已撤销。',
    ]);
    expect(copy(ESIGN_REVOKED_EMPLOYEE_TEMPLATE)).toEqual([
      '电子签署已撤销',
      '您的{场景}（{文件名称}）已撤销，无需再签署。',
    ]);
    expect(copy(ESIGN_COMPLETED_EMPLOYEE_TEMPLATE)).toEqual([
      '电子签署已完成',
      '您的{场景}（{文件名称}）已签署完成，可在「我的签署」下载。',
    ]);
    expect(copy(ESIGN_COMPLETED_INITIATOR_TEMPLATE)).toEqual([
      '电子签署已完成',
      '{员工姓名}的{场景}（{文件名称}）已签署完成。',
    ]);
  });

  it('目录自检：正文的占位符都在 variables 里，variables 都在正文出现', () => {
    for (const [code, template] of Object.entries(ESIGN_NOTICE_TEMPLATES)) {
      const used = [...template.body.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!);
      expect([code, [...new Set(used)].sort()]).toEqual([code, [...template.variables].sort()]);
    }
  });

  it('渲染：变量齐全时替换；缺变量正文为 null；目录外模板码为 null', () => {
    const payload = { 场景: '调动电子签署', 文件名称: esignFileLabel(['甲', '乙']), 员工姓名: '合成员工' };
    expect(renderEsignNotice(ESIGN_REVOKED_INITIATOR_TEMPLATE, payload)).toEqual({
      title: '电子签署已撤销',
      body: '合成员工的调动电子签署（甲、乙）已撤销。',
    });
    expect(renderEsignNotice(ESIGN_REMIND_TEMPLATE, payload)?.body).toBeNull();
    expect(renderEsignNotice('other_template', payload)).toBeNull();
    expect(renderEsignNotice(null, payload)).toBeNull();
  });

  it('文件名称：至多 3 个用“、”连接，超过 3 个写“等 N 份文件”', () => {
    expect(esignFileLabel(['甲'])).toBe('甲');
    expect(esignFileLabel(['甲', '乙', '丙'])).toBe('甲、乙、丙');
    expect(esignFileLabel(['甲', '乙', '丙', '丁'])).toBe('等 4 份文件');
  });
});

describe('F-481 场景设置规则（设计 §4.1 / §5.4）', () => {
  it('有效期只接受 2～30 的整数', () => {
    for (const ok of [2, 3, 30]) expect(isValidValidityDays(ok)).toBe(true);
    for (const bad of [1, 31, 0, -1, 2.5, '5', null, NaN]) expect(isValidValidityDays(bad)).toBe(false);
  });

  it('到期时间 = 发起时刻 + N × 24 小时（不按租户日历日）', () => {
    expect(esignExpiresAt(new Date('2026-11-30T02:00:00.000Z'), 2).toISOString()).toBe('2026-12-02T02:00:00.000Z');
    expect(esignExpiresAt(new Date('2026-11-30T02:00:00.000Z'), 30).toISOString()).toBe('2026-12-30T02:00:00.000Z');
  });
});
