/**
 * BE-2b 入职生成合同端口接线（docs/02_业务建模/34 EN-R11；generateContractForBusiness）：
 * 办理入职时带合同信息 → 与人员状态流转同一事务生成合同；合同失败整笔回滚；不带合同信息则行为不变。
 * 只做办理入职一处接线（DEC-540：不联动改期 / 取消 / 删除对合同的影响，那些行为原站未验证）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { CONTRACT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addPending,
  businessRevision,
  entryAction,
  entryRecords,
  entryWorld,
  type EntryWorld,
} from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00.000Z');

interface ContractRow {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly endDate: string | null;
  readonly termType: string;
  readonly status: string;
}

async function contractWorld(label: string) {
  const w = await entryWorld(testDb().db, label);
  const api = tenantApi(w.db, { clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await api.request('POST', `/api/tenant/contracts/master-data/${kind}`, {
      ...as,
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const typeId = await master('types', '劳动合同');
  const companyId = await master('companies', '合成法人公司');
  const contract = { typeId, companyId, termType: 'fixed', termMonths: 12, endDate: '2027-08-31' };
  async function contracts(): Promise<ContractRow[]> {
    const response = await api.request('GET', '/api/tenant/contracts?view=all', as);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: ContractRow[] }).items;
  }
  return { w, contract, contracts };
}

describe('BE-2b 办理入职生成合同', () => {
  it('带合同信息办理入职：状态流转与合同同事务；合同生效日默认取入职日', async () => {
    const { w, contract, contracts } = await contractWorld('be2b-ct-ok');
    const { employee, recordId } = await addPending(w, '2026-09-01');
    const response = await entryAction(w, recordId, 'complete', { probation: true, contract });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 2 });
    expect(await contracts()).toMatchObject([
      { employeeId: employee.id, effectiveDate: '2026-09-01', endDate: '2027-08-31', termType: 'fixed' },
    ]);
  });

  it('合同可显式给生效日；入职日在将来时合同按自己的生效日排期', async () => {
    const { w, contract, contracts } = await contractWorld('be2b-ct-future');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    const body = { probation: false, contract: { ...contract, effectiveDate: '2026-10-12', endDate: '2027-10-11' } };
    const response = await entryAction(w, recordId, 'complete', body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await contracts()).toMatchObject([{ employeeId: employee.id, effectiveDate: '2026-10-12' }]);
  });

  it('不带合同信息：行为同 BE-2a，不生成合同', async () => {
    const { w, contracts } = await contractWorld('be2b-ct-none');
    const { recordId } = await addPending(w, '2026-09-01');
    expect((await entryAction(w, recordId, 'complete', { probation: false })).status).toBe(200);
    expect(await contracts()).toEqual([]);
  });

  it.each([
    ['固定期限缺终止日期', { endDate: undefined }],
    ['终止日期不晚于生效日', { endDate: '2026-09-01' }],
    ['缺法人公司', { companyId: undefined }],
    ['合同类型不是 UUID', { typeId: 'x' }],
    ['合同字段不在白名单（employmentRecordId 不可由请求指定）', { employmentRecordId: randomUUID() }],
  ])('合同校验不过 → 整笔回滚：%s', async (_name, patch) => {
    const { w, contract, contracts } = await contractWorld(`be2b-ct-bad-${_name.length}`);
    const { employee, recordId } = await addPending(w, '2026-09-01');
    const response = await entryAction(w, recordId, 'complete', {
      probation: true,
      contract: { ...contract, ...patch },
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 1 });
    expect(await contracts()).toEqual([]);
    // 回滚后可以改正重提
    expect((await entryAction(w, recordId, 'complete', { probation: true, contract })).status).toBe(200);
    expect(await contracts()).toHaveLength(1);
  });

  it('没有合同对象的创建权限：403，待入职保持待入职', async () => {
    const { w, contract, contracts } = await contractWorld('be2b-ct-denied');
    const { employee, recordId } = await addPending(w, '2026-09-01');
    const authorize: Authorizer = (request) =>
      !(request.action === 'object.create' && request.resource === CONTRACT_OBJECT);
    const api = tenantApi(w.db, { authorize, clock });
    const response = await api.request('POST', `/api/tenant/employment/pending-entries/${recordId}/complete`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: await businessRevision(w, recordId),
      body: { probation: true, contract },
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ employeeStatus: 1 });
    expect(await contracts()).toEqual([]);
  });

  it('同一幂等键重放不重复生成合同', async () => {
    const { w, contract, contracts } = await contractWorld('be2b-ct-replay');
    const { recordId } = await addPending(w, '2026-09-01');
    const key = randomUUID();
    const revision = await businessRevision(w, recordId);
    const send = (w2: EntryWorld) =>
      w2.session.request('POST', `/pending-entries/${recordId}/complete`, {
        ifMatch: revision,
        idempotencyKey: key,
        body: { probation: true, contract },
      });
    const first = await send(w);
    expect(first.status, await first.clone().text()).toBe(200);
    expect((await send(w)).status).toBe(200);
    expect(await contracts()).toHaveLength(1);
  });

  it('已取消入职不能办理，合同也不生成', async () => {
    const { w, contract, contracts } = await contractWorld('be2b-ct-cancelled');
    const { recordId } = await addPending(w, '2026-09-01');
    expect((await entryAction(w, recordId, 'cancel', {})).status).toBe(200);
    const response = await entryAction(w, recordId, 'complete', { probation: true, contract });
    expect(response.status).toBe(409);
    expect(await contracts()).toEqual([]);
  });
});
