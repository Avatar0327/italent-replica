/**
 * 缴交方案种子 / 导入脚本（F-474-8c-2b，设计 F-474-8b §4.1 / §7，U4-A：不开维护页面、不加写路由）。
 * 方案与方案版本对运行时角色只读（迁移 0218），这里以属主连接写，但仍带租户上下文（app.tenant_id），
 * 所以 FORCE RLS 下也只写得进目标租户。
 *
 * 用法（DATABASE_URL 取自环境变量，不要写进命令行或文件）：
 *   node --conditions=@italent/source --import tsx scripts/seed-insurance-plans.mjs <租户ID> <方案.json>
 * 方案.json = PlanSeed[]（字段见 seed-insurance-plans.d.mts）。幂等：同一方案编码 + 生效月内容一致则跳过，
 * 内容不一致整批失败；任何一条不合法整批回滚，什么都不写。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPgDb, isUuid, sql } from '@italent/db';

const MONTH = /^(\d{4})-(\d{2})-01$/;
const FAR = '9999-12-01';

function fail(message) {
  throw new Error(`方案种子不合法：${message}`);
}

function checkMonth(value, label) {
  const match = typeof value === 'string' ? MONTH.exec(value) : null;
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) fail(`${label}必须是某月 1 号（YYYY-MM-01）：${value}`);
}

/** 入库前的整批校验：编码唯一、名称非空、月份格式、同一方案的 [生效月, 停用月) 不重叠（首尾相接合法）。 */
function validate(plans) {
  if (!Array.isArray(plans) || plans.length === 0) fail('方案清单不能为空');
  const codes = new Set();
  for (const plan of plans) {
    const code = typeof plan?.code === 'string' ? plan.code.trim() : '';
    if (!code) fail('方案编码不能为空');
    if (codes.has(code)) fail(`方案编码重复：${code}`);
    codes.add(code);
    if (!Array.isArray(plan.versions) || plan.versions.length === 0) fail(`方案 ${code} 至少要有一个版本`);
    for (const version of plan.versions) {
      if (typeof version.name !== 'string' || version.name.trim() === '') fail(`方案 ${code} 的版本名称不能为空`);
      if (!/^\d{6}$/.test(String(version.regionCode))) fail(`方案 ${code} 的缴交地必须是 6 位数字`);
      checkMonth(version.effectiveMonth, `方案 ${code} 的生效月`);
      // 未提供 = 启用；显式 null / 非布尔不静默当成启用（整批拒绝）
      if (version.enabled !== undefined && typeof version.enabled !== 'boolean')
        fail(`方案 ${code} 的 enabled 只能省略或为布尔值`);
      if (version.stopMonth != null) {
        checkMonth(version.stopMonth, `方案 ${code} 的停用月`);
        if (version.stopMonth <= version.effectiveMonth) fail(`方案 ${code} 的停用月必须晚于生效月`);
      }
    }
    const ordered = [...plan.versions].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth));
    ordered.forEach((version, index) => {
      const next = ordered[index + 1];
      if (next && (version.stopMonth ?? FAR) > next.effectiveMonth)
        fail(`方案 ${code} 的版本区间重叠：${version.effectiveMonth} 与 ${next.effectiveMonth}`);
    });
  }
}

const rowsOf = (result) => (Array.isArray(result) ? result : (result.rows ?? []));
const same = (row, version) =>
  row.name === version.name.trim() &&
  row.region_code === version.regionCode &&
  (row.stop_month ?? null) === (version.stopMonth ?? null) &&
  row.enabled === (version.enabled ?? true);

async function ensurePlan(tx, tenantId, code, receipt) {
  const [found] = rowsOf(
    await tx.execute(sql`SELECT id FROM social_insurance_plans
    WHERE tenant_id = ${tenantId} AND code = ${code}`),
  );
  if (found) {
    receipt.plans.existing += 1;
    return found.id;
  }
  const [created] = rowsOf(
    await tx.execute(sql`INSERT INTO social_insurance_plans (tenant_id, code)
    VALUES (${tenantId}, ${code}) RETURNING id`),
  );
  receipt.plans.created += 1;
  return created.id;
}

async function ensureVersion(tx, tenantId, planId, code, version, receipt) {
  const [found] = rowsOf(
    await tx.execute(sql`SELECT name, region_code, stop_month::text AS stop_month, enabled
    FROM social_insurance_plan_versions
    WHERE tenant_id = ${tenantId} AND plan_id = ${planId} AND effective_month = ${version.effectiveMonth}::date`),
  );
  if (found) {
    if (!same(found, version)) fail(`方案 ${code} 的 ${version.effectiveMonth} 版本已存在且内容不一致（冲突）`);
    receipt.versions.existing += 1;
    return;
  }
  await tx.execute(sql`INSERT INTO social_insurance_plan_versions
    (tenant_id, plan_id, name, region_code, effective_month, stop_month, enabled)
    VALUES (${tenantId}, ${planId}, ${version.name.trim()}, ${version.regionCode}, ${version.effectiveMonth}::date,
      ${version.stopMonth ?? null}::date, ${version.enabled ?? true})`);
  receipt.versions.created += 1;
}

export async function seedInsurancePlans(db, tenantId, plans) {
  if (!isUuid(tenantId)) throw new TypeError('方案种子：租户 ID 必须是 UUID');
  validate(plans);
  const receipt = { plans: { created: 0, existing: 0 }, versions: { created: 0, existing: 0 } };
  await db.transaction(async (tx) => {
    // 只设租户上下文、不切角色：方案表对运行时角色只读，属主写入仍受 tenant_isolation 约束
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    const regions = new Set(rowsOf(await tx.execute(sql`SELECT code FROM admin_regions`)).map((row) => row.code));
    for (const plan of plans)
      for (const version of plan.versions)
        if (!regions.has(version.regionCode)) fail(`方案 ${plan.code} 的缴交地不在区划字典内：${version.regionCode}`);
    for (const plan of plans) {
      const code = plan.code.trim();
      const planId = await ensurePlan(tx, tenantId, code, receipt);
      for (const version of plan.versions) await ensureVersion(tx, tenantId, planId, code, version, receipt);
    }
  });
  return receipt;
}

async function main(argv) {
  const [tenantId, file] = argv;
  const url = process.env.DATABASE_URL;
  if (!tenantId || !file || !url) {
    console.error('用法：DATABASE_URL=… node … scripts/seed-insurance-plans.mjs <租户ID> <方案.json>');
    process.exitCode = 2;
    return;
  }
  const handle = createPgDb(url, { max: 1, applicationName: 'seed-insurance-plans' });
  try {
    const receipt = await seedInsurancePlans(handle.db, tenantId, JSON.parse(readFileSync(file, 'utf8')));
    console.log(JSON.stringify(receipt));
  } finally {
    await handle.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
