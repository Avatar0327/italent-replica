/**
 * REQ-APV-001 流程定义与版本：草稿 / 发布 / 废弃；已发布不可直接改，只能编辑最新版本；实例冻结发起时版本；
 * 发布校验（DEC-018 / DEC-054）；按审批类型过滤后按优先级匹配（DEC-017）；出厂预置调动流程（DEC-018）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type ProcessView } from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

describe('AC-APV-05/06/07 版本规则', () => {
  it('已发布流程不可直接修改；编辑最新版本发布后只影响新实例，在途实例按旧版本流转', async () => {
    const w = await approvalWorld(database().db, 'apv-version');
    const s = await transferScene(w);
    let process = await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head' },
        { key: 'in_head', approver: 'record_department_head' },
      ],
    });
    expect(process).toMatchObject({
      currentVersion: { versionNo: 1, status: 'published' },
      latestVersion: { versionNo: 1, status: 'published' },
    });
    const old = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(old.versionNo).toBe(1);

    const edit = await w.request(w.hr.id, 'PUT', `${BASE}/processes/${process.id}/draft`, {
      ifMatch: process.revision,
      body: { name: '直接修改', nodes: [{ key: 'in_hrbp', approver: 'record_department_hrbp' }] },
    });
    expect(edit.status).toBe(409);
    expect(await edit.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_VERSION_PUBLISHED' } } });

    process = await w.json<ProcessView>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id}/versions`, { ifMatch: process.revision }),
      201,
    );
    expect(process).toMatchObject({
      currentVersion: { versionNo: 1, status: 'published' },
      latestVersion: { versionNo: 2, status: 'draft' },
    });
    process = await w.json<ProcessView>(
      await w.request(w.hr.id, 'PUT', `${BASE}/processes/${process.id}/draft`, {
        ifMatch: process.revision,
        body: {
          name: '第二版',
          priority: 0,
          isFallback: false,
          exceptionAdminUserId: w.hr.id,
          conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
          nodes: [{ key: 'in_hrbp', approver: 'record_department_hrbp' }],
        },
      }),
    );
    process = await w.publish(process);
    expect(process).toMatchObject({ currentVersion: { versionNo: 2, name: '第二版' } });

    const fresh = await w.submit(await w.application(s.manager.employeeId, { departmentId: s.to }));
    expect(fresh).toMatchObject({ versionNo: 2, currentNodeKey: 'in_hrbp' });
    const legacy = await w.detail(old.id);
    expect(legacy).toMatchObject({ versionNo: 1, currentNodeKey: 'out_head' });
    const approved = await w.json<{ currentNodeKey: string; versionNo: number }>(
      await w.taskAction(s.outHead.userId, w.pending(legacy)[0]!.id, 'approve', legacy.revision),
    );
    expect(approved).toMatchObject({ versionNo: 1, currentNodeKey: 'in_head' });
  });
});

describe('AC-APV-08 废弃', () => {
  it('废弃后从可用列表移除，进入废弃列表，不能再被发起', async () => {
    const w = await approvalWorld(database().db, 'apv-discard');
    const s = await transferScene(w);
    const process = await w.publishedProcess({ nodes: TRANSFER_NODES });
    const discarded = await w.json<ProcessView>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id}/discard`, { ifMatch: process.revision }),
    );
    expect(discarded.status).toBe('discarded');
    const available = await w.json<{ items: { id: string }[] }>(await w.request(w.hr.id, 'GET', `${BASE}/processes`));
    expect(available.items.map((item) => item.id)).not.toContain(process.id);
    const archive = await w.json<{ items: { id: string }[] }>(
      await w.request(w.hr.id, 'GET', `${BASE}/processes?status=discarded`),
    );
    expect(archive.items.map((item) => item.id)).toContain(process.id);
    const response = await w.submitRaw(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_PROCESS_NOT_MATCHED' } } });
  });
});

describe('AC-APV-09 多流程同时满足：按优先级（越小越先），并列按编码确定性选择', () => {
  it('优先级 -1 的条件流程先于 0；兜底流程最后；草稿不参与匹配', async () => {
    const w = await approvalWorld(database().db, 'apv-priority');
    const s = await transferScene(w);
    const generic = await w.publishedProcess({ code: 'B_GENERIC', priority: 0, nodes: [TRANSFER_NODES[2]!] });
    const precise = await w.publishedProcess({
      code: 'Z_PRECISE',
      priority: -1,
      conditions: {
        items: [
          { no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' },
          { no: 2, field: 'before.departmentId', operator: 'in_org_tree', value: s.from },
          { no: 3, field: 'employee.name', operator: 'eq', value: '调动员工' },
        ],
        expression: '1 and 2 and 3',
      },
      nodes: [TRANSFER_NODES[0]!],
    });
    await w.publishedProcess({
      code: 'A_FALLBACK',
      priority: -9,
      isFallback: true,
      conditions: { items: [] },
      nodes: [TRANSFER_NODES[1]!],
    });
    await w.createProcess({ code: 'A_DRAFT', priority: -99, nodes: [TRANSFER_NODES[1]!] });
    const first = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(first.processId).toBe(precise.id);
    const second = await w.submit(await w.application(s.manager.employeeId, { departmentId: s.to }));
    expect(second.processId).toBe(generic.id);
    const custom = await w.submit(
      await w.application(s.outHead.employeeId, { departmentId: s.to }),
      w.hr.id,
      'Customized1TransferFlow',
    );
    expect(custom.currentNodeKey).toBe('in_hrbp');
  });
});

describe('AC-APV-18 / AC-APV-13 发布校验', () => {
  it('发起条件为空且未标记兜底 → 拒绝；未配置异常管理员 → 拒绝；标记兜底可发布', async () => {
    const w = await approvalWorld(database().db, 'apv-publish');
    const empty = await w.createProcess({ conditions: { items: [] }, nodes: TRANSFER_NODES });
    const rejected = await w.request(w.hr.id, 'POST', `${BASE}/processes/${empty.id}/publish`, {
      ifMatch: empty.revision,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'APPROVAL_CONDITION_REQUIRED' } },
    });
    const noAdmin = await w.createProcess({ exceptionAdminUserId: null, nodes: TRANSFER_NODES });
    const missing = await w.request(w.hr.id, 'POST', `${BASE}/processes/${noAdmin.id}/publish`, {
      ifMatch: noAdmin.revision,
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_EXCEPTION_ADMIN_REQUIRED' } } });
    const fallback = await w.createProcess({ isFallback: true, conditions: { items: [] }, nodes: TRANSFER_NODES });
    expect((await w.publish(fallback)).currentVersion).toMatchObject({ isFallback: true });
    const invalid = await w.request(w.hr.id, 'POST', `${BASE}/processes`, {
      ifMatch: 0,
      body: {
        code: 'BAD_FIELD',
        name: '非法字段',
        approvalType: 'transfer',
        priority: 0,
        isFallback: false,
        exceptionAdminUserId: w.hr.id,
        conditions: { items: [{ no: 1, field: 'employee.salary', operator: 'eq', value: '1' }] },
        nodes: TRANSFER_NODES,
      },
    });
    expect(invalid.status).toBe(400);
  });
});

describe('AC-APV-19 / AC-TRF-29 按审批类型隔离（DEC-017）', () => {
  it('只有离职类流程满足条件时不发起调动，明确报错', async () => {
    const w = await approvalWorld(database().db, 'apv-isolation');
    const s = await transferScene(w);
    await w.publishedProcess({
      approvalType: 'leave',
      isFallback: true,
      conditions: { items: [] },
      nodes: [TRANSFER_NODES[0]!],
    });
    const response = await w.submitRaw(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: '没有可用的调动流程', details: { reason: 'APPROVAL_PROCESS_NOT_MATCHED' } },
    });
  });
});

describe('DEC-018 出厂预置调动流程', () => {
  it('按本租户节点结构预置为草稿，带流程编码条件；配置异常管理员后可发布并发起', async () => {
    const w = await approvalWorld(database().db, 'apv-preset');
    const s = await transferScene(w);
    const installed = await w.json<{ items: ProcessView[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }),
    );
    const preset = installed.items.find((item) => item.presetKey === 'standard_transfer')!;
    expect(preset).toMatchObject({
      approvalType: 'transfer',
      objectCode: 'TenantBase.EmploymentRecord',
      currentVersion: null,
      latestVersion: {
        status: 'draft',
        exceptionAdminUserId: null,
        conditions: { items: [{ field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
        nodes: [
          { key: 'out_head', approver: 'latest_record_department_head' },
          { key: 'in_hrbp', approver: 'record_department_hrbp' },
          { key: 'in_head', approver: 'record_department_head' },
          { key: 'first_level', approver: 'record_first_level_org_head' },
        ],
      },
    });
    const again = await w.json<{ items: ProcessView[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/presets/install`, { ifMatch: 0 }),
    );
    expect(again.items.map((item) => item.id)).toEqual(installed.items.map((item) => item.id));
    const blocked = await w.request(w.hr.id, 'POST', `${BASE}/processes/${preset.id}/publish`, {
      ifMatch: preset.revision,
    });
    expect(blocked.status).toBe(400);
    const latest = preset.latestVersion;
    const configured = await w.json<ProcessView>(
      await w.request(w.hr.id, 'PUT', `${BASE}/processes/${preset.id}/draft`, {
        ifMatch: preset.revision,
        body: {
          name: latest.name,
          priority: latest.priority,
          isFallback: latest.isFallback,
          exceptionAdminUserId: w.hr.id,
          conditions: latest.conditions,
          nodes: latest.nodes,
        },
      }),
    );
    await w.publish(configured);
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(view).toMatchObject({ processId: preset.id, currentNodeKey: 'out_head' });
  });
});
