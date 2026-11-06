/**
 * AC-APV-F478-03（S1，设计 §2.1）：节点出口 CHECK 放宽到业务出口组，会签节点不得使用；
 * 路由条件的单值 / 列表值两个载体互斥。直接 SQL 写入，约束在数据库里兜底（不依赖服务层校验）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, type ApprovalWorld, type NodeInput } from './AC-APV-support.js';
import { publishRouted } from './AC-APV-F478-support.js';

const testDb = useTestDb();
const CHECK_VIOLATION = '23514';

async function scene(label: string) {
  const w = await approvalWorld(testDb().db, label);
  const a = await w.person('审批人甲', await w.org('部门'));
  const b = await w.person('审批人乙', await w.org('部门乙'));
  const nodes: NodeInput[] = [
    { key: 'solo', approver: { type: 'specified', value: a.userId } },
    {
      key: 'joint',
      kind: 'countersign',
      approvers: [
        { type: 'specified', value: a.userId },
        { type: 'specified', value: b.userId },
      ],
      transitionRule: { type: 'any' },
    },
  ];
  return { w, nodes, process: await w.createProcess({ nodes }) };
}

/** 在租户事务里执行一条会失败的 SQL，返回 PG 错误码（成功返回 undefined）。 */
async function sqlState(
  w: ApprovalWorld,
  run: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>,
) {
  try {
    await withTenant(w.db, w.tenant.id, run);
    return undefined;
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    return failure.code ?? failure.cause?.code ?? 'error';
  }
}

let nodeSeq = 100;
const list = (items: readonly string[]) =>
  sql`ARRAY[${sql.join(
    items.map((item) => sql`${item}`),
    sql`, `,
  )}]::text[]`;

/** 经直接 SQL 向草稿版本新插一个节点（节点表对业务角色只开放 INSERT / DELETE）。 */
async function setExits(
  w: ApprovalWorld,
  versionId: string,
  nodeType: 'single' | 'countersign',
  exits: readonly string[],
) {
  nodeSeq += 1;
  const single = nodeType === 'single';
  return sqlState(w, (tx) =>
    tx.execute(sql`INSERT INTO approval_process_nodes
      (tenant_id,version_id,node_key,seq,name,node_type,approver_expression,approver_expressions,
       transition_rule_type,exits)
      VALUES (${w.tenant.id},${versionId}::uuid,${`x${nodeSeq}`},${nodeSeq},'探针节点',${nodeType},
        ${single ? sql`'{"type":"specified","value":"u"}'::jsonb` : sql`NULL`},
        ${single ? sql`'[]'::jsonb` : sql`'[{"type":"specified","value":"u"}]'::jsonb`},
        ${single ? sql`NULL` : sql`'any'`},${list(exits)})`),
  );
}

describe('AC-APV-F478-03 出口集合 CHECK', () => {
  it('单人节点：完整出口组合法；缺半边、与 approve 并存都被 CHECK 拒绝', async () => {
    const { w, process } = await scene('f478-03-exits');
    const v = await seedRoute(w, process.id);
    expect(await setExits(w, v, 'single', ['approve_no_rehire', 'approve_rehire'])).toBeUndefined();
    expect(await setExits(w, v, 'single', ['approve_no_rehire', 'approve_rehire', 'disagree'])).toBeUndefined();
    expect(await setExits(w, v, 'single', ['approve_rehire'])).toBe(CHECK_VIOLATION);
    expect(await setExits(w, v, 'single', ['approve_no_rehire', 'disagree'])).toBe(CHECK_VIOLATION);
    expect(await setExits(w, v, 'single', ['approve', 'approve_no_rehire', 'approve_rehire'])).toBe(CHECK_VIOLATION);
    expect(await setExits(w, v, 'single', ['approve', 'disagree'])).toBeUndefined();
  });

  it('会签节点：写业务出口被 CHECK 拒绝，通用出口照常', async () => {
    const { w, process } = await scene('f478-03-countersign');
    const v = await seedRoute(w, process.id);
    expect(await setExits(w, v, 'countersign', ['approve_no_rehire', 'approve_rehire'])).toBe(CHECK_VIOLATION);
    expect(await setExits(w, v, 'countersign', ['approve', 'disagree'])).toBeUndefined();
  });

  it('不在白名单的出口编码仍被拒绝', async () => {
    const { w, process } = await scene('f478-03-unknown');
    const v = await seedRoute(w, process.id);
    expect(await setExits(w, v, 'single', ['approve', 'custom_exit'])).toBe(CHECK_VIOLATION);
  });
});

async function seedRoute(w: ApprovalWorld, processId: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT v.id FROM approval_process_versions v
      WHERE v.tenant_id=${w.tenant.id} AND v.process_id=${processId}::uuid ORDER BY version_no DESC LIMIT 1`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string }[];
    return rows[0]!.id;
  });
}

const insertCondition = (w: ApprovalWorld, versionId: string, text: string | null, list: readonly string[] | null) =>
  sqlState(w, async (tx) => {
    await tx.execute(sql`INSERT INTO approval_node_exit_routes
      (tenant_id,version_id,node_key,exit,branch_no,kind,priority,expression,target_node_key)
      VALUES (${w.tenant.id},${versionId}::uuid,'solo','approve',1,'condition',1,'1','joint')`);
    await tx.execute(sql`INSERT INTO approval_node_exit_route_conditions
      (tenant_id,version_id,node_key,exit,branch_no,item_no,field_path,operator,value_text,value_list)
      VALUES (${w.tenant.id},${versionId}::uuid,'solo','approve',1,1,'record.departmentId','in',${text},
        ${
          list
            ? sql`ARRAY[${sql.join(
                list.map((item) => sql`${item}`),
                sql`, `,
              )}]::text[]`
            : sql`NULL`
        })`);
  });

describe('AC-APV-F478-03 路由条件载体互斥', () => {
  it('单值与列表值同时非空 → CHECK 拒绝；只填其一合法', async () => {
    const { w, process } = await scene('f478-03-carrier');
    const versionId = await seedRoute(w, process.id);
    expect(await insertCondition(w, versionId, 'x', ['a', 'b'])).toBe(CHECK_VIOLATION);
    expect(await insertCondition(w, versionId, null, ['a', 'b'])).toBeUndefined();
  });

  it('发布的路由流程仍保留互斥约束：已发布版本的路由行不可再删（沿用草稿保护）', async () => {
    const s = await scene('f478-03-published');
    const published = await publishRouted(s.w, s.nodes, {
      solo: [{ exit: 'approve', branches: [{ kind: 'direct', target: 'joint' }] }],
    });
    const versionId = await seedRoute(s.w, published.id);
    const state = await sqlState(s.w, (tx) =>
      tx.execute(sql`DELETE FROM approval_node_exit_routes
        WHERE tenant_id=${s.w.tenant.id} AND version_id=${versionId}::uuid`),
    );
    expect(state).toBe('55000');
  });
});
