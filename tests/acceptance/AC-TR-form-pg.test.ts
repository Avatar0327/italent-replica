/**
 * AC-TR-form-pg · R3-T04 PR-B3 引用并发（真 PostgreSQL；设计 §2.2）：表单 / 流程节点写入引用字段 / 角色时对被引用行加 KEY SHARE，
 * 与被引用对象的删除（行 FOR UPDATE）互斥——要么引用先提交、删除得到 409 *_IN_USE，要么删除先提交、引用得到 404，
 * 不会出现悬空引用，也不会撞外键 500。同一表单同一 revision 的并发修改只有一个成功。PGlite 单连接无法并发，
 * 仅在设置 TEST_DATABASE_URL 时运行。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { FLOWS, flowBody, FORMS, formBody, formFlowWorld, type FormView, nodeBody } from './AC-TR-form-flow-support.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('表单 / 流程引用 · PostgreSQL 16 并发', () => {
  it('新建引用字段的表单与删除该字段同时发生：要么表单建成且字段删除 409，要么字段先删表单 404，库里无悬空引用', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-pg-field');
    const field = await w.field();
    const [create, remove] = await Promise.all([
      w.post(FORMS, formBody([{ fieldId: field.id }])),
      w.request('DELETE', `/fields/${field.id}`, { ifMatch: 1 }),
    ]);
    const forms = (await w.list<FormView>(FORMS)).items;
    if (create.status === 201) {
      expect(remove.status).toBe(409);
      expect(forms).toHaveLength(1);
      expect(forms[0]!.fields.map((row) => row.fieldId)).toEqual([field.id]);
    } else {
      expect([create.status, remove.status]).toEqual([404, 200]);
      expect(forms).toEqual([]);
    }
  });

  it('新建引用角色的流程与删除该角色同时发生：同样互斥，无悬空引用', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-pg-role');
    const role = await w.role();
    const [create, remove] = await Promise.all([
      w.post(FLOWS, flowBody([nodeBody([role.id])])),
      w.request('DELETE', `/roles/${role.id}`, { ifMatch: 1 }),
    ]);
    const flows = (await w.list<{ nodes: { roleIds: string[] }[] }>(FLOWS)).items;
    if (create.status === 201) {
      expect(remove.status).toBe(409);
      expect(flows[0]!.nodes[0]!.roleIds).toEqual([role.id]);
    } else {
      expect([create.status, remove.status]).toEqual([404, 200]);
      expect(flows).toEqual([]);
    }
  });

  it('同一表单同一 revision 并发修改：一个 200，一个 409，revision 只加 1', async () => {
    const w = await formFlowWorld(testDb().db, 'trf-pg-revision');
    const form = await w.createForm();
    const patch = (name: string) => w.request('PATCH', `${FORMS}/${form.id}`, { ifMatch: 1, body: { name } });
    const responses = await Promise.all([patch('甲'), patch('乙')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await w.read<FormView>(FORMS, form.id)).body.revision).toBe(2);
  });
});
