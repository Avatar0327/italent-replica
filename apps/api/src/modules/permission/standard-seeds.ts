/**
 * 标准身份补装的两个种子登记项（DEC-361 登记表；F-061 方案 §3.2、§4、§5）：
 * - permission/standard-profiles：缺整个身份时补装（沿用 #117 / DEC-289③ 口径：同编码手工身份不装、不覆盖）；
 * - permission/standard-profile-grants：已装身份上缺的应用 / 对象 / 数据操作 / 字段 / 按钮。
 * 授权层的核心规则：缺失 = 当前没有 ∧ 台账（seed_grant_ledger）没有，所以租户撤销过的不会补回；只增不删。
 * 台账由 existing 的“持续登记”与“首次接管”写、由 install / 开通 / 租户保存写；全部在补装锁（lockTenantSeeds）之后、
 * 标准身份行 FOR UPDATE 之后进行，与租户保存对象权限（同样先锁身份行）串行。
 */
import {
  and,
  asc,
  auditEvents,
  eq,
  inArray,
  permissionIdentityScopes,
  permissionProfileApps,
  permissionProfileButtons,
  permissionProfileFields,
  permissionProfileObjects,
  permissionProfiles,
  type PermissionProfile,
  sql,
  type Tx,
} from '@italent/db';
import {
  appGrantCode,
  buttonGrantCode,
  fieldGrantCode,
  type GrantItem,
  grantParentCode,
  isWithinProfileApps,
  type PresetSeeAllTarget,
  objectGrantCode,
  opGrantCode,
  parseGrantCode,
  seeAllGrantCode,
  profileLedgerMarker,
  STANDARD_GRANT_CODES,
  STANDARD_GRANT_ENTRY,
  STANDARD_GRANT_VERSION,
  STANDARD_PROFILES,
  standardGrantItems,
  validateObjectPermission,
  type ButtonLevel,
  type ObjectPermission,
} from '@italent/domain';
import { readLedger, recordLedger } from '../../seeds/grant-ledger.js';
import { registerSeed, type SeedInstallResult, type SeedSkip, type SeedWriteContext } from '../../seeds/registry.js';
import { auditAs } from './audit.js';
import { objectCatalog } from './catalog.js';
import { installProfilesForTenantAdmins, presetSeeAll } from './standard-profiles.js';
import { lockIdentityScope } from './scope-policy-service.js';
import './standard-managed-grants.js';
import { replaceObjectRows } from './profiles.js';
import { loadObjectPermissions } from './subject.js';
import { tenantObjectCatalog } from './tenant-catalog.js';

const PROFILE_ENTRY = { module: 'permission', key: 'standard-profiles' } as const;
const GRANT_ENTRY = { module: 'permission', key: 'standard-profile-grants' } as const;

/** 测试探针：首次接管读完某身份的审计之后调用（T-22 在这里插入审计清理，验证接管只读一次审计）。 */
export const takeoverProbe: { afterAuditRead?: (profileCode: string) => Promise<void> } = {};

registerSeed({
  ...PROFILE_ENTRY,
  version: 1,
  codes: STANDARD_PROFILES.map((profile) => profile.code),
  // 不论 source：手工同编码身份计入已有（CODE_TAKEN），不装、不覆盖
  existing: async (tx) =>
    new Set((await tx.select({ code: permissionProfiles.code }).from(permissionProfiles)).map((p) => p.code)),
  install: async (tx, write, missing) => {
    const wanted = new Set(missing);
    await installProfilesForTenantAdmins(
      tx,
      write,
      STANDARD_PROFILES.filter((profile) => wanted.has(profile.code)),
    );
  },
});

const itemsByProfile = new Map(STANDARD_PROFILES.map((profile) => [profile.code, standardGrantItems([profile])]));
const objectOf = (item: GrantItem) => ('objectCode' in item ? item.objectCode : undefined);
const appOf = (objectCode: string) => objectCatalog.get(objectCode)?.application;

registerSeed({
  ...GRANT_ENTRY,
  version: STANDARD_GRANT_VERSION,
  codes: STANDARD_GRANT_CODES,
  existing: existingGrants,
  install: installGrants,
});

interface CurrentGrants {
  /** 身份编码 → 当前已有的授权项编码（应用、对象、数据操作、字段、按钮、see_all = true 的看全部）。 */
  readonly have: Map<string, Set<string>>;
  /** 身份编码 → 范围行在但 see_all = false 的看全部编码（租户关过，不可装、不记账）。 */
  readonly closed: Map<string, Set<string>>;
}

/** 标准身份当前的授权项编码。 */
async function currentGrantCodes(tx: Tx, profiles: readonly PermissionProfile[]): Promise<CurrentGrants> {
  const codeOf = new Map(profiles.map((p) => [p.id, p.code]));
  const ids = profiles.map((p) => p.id);
  const have = new Map(profiles.map((p) => [p.code, new Set<string>()]));
  const closed = new Map(profiles.map((p) => [p.code, new Set<string>()]));
  const add = (profileId: string, code: (profileCode: string) => string) => {
    const profileCode = codeOf.get(profileId)!;
    have.get(profileCode)!.add(code(profileCode));
  };
  if (ids.length === 0) return { have, closed };
  for (const row of await tx.select().from(permissionProfileApps).where(inArray(permissionProfileApps.profileId, ids)))
    add(row.profileId, (p) => appGrantCode(p, row.appCode));
  for (const row of await tx
    .select()
    .from(permissionProfileObjects)
    .where(inArray(permissionProfileObjects.profileId, ids))) {
    add(row.profileId, (p) => objectGrantCode(p, row.objectCode));
    if (row.canCreate) add(row.profileId, (p) => opGrantCode(p, row.objectCode, 'create'));
    if (row.canUpdate) add(row.profileId, (p) => opGrantCode(p, row.objectCode, 'update'));
    if (row.canDelete) add(row.profileId, (p) => opGrantCode(p, row.objectCode, 'delete'));
  }
  for (const row of await tx
    .select()
    .from(permissionProfileFields)
    .where(inArray(permissionProfileFields.profileId, ids))) {
    if (row.canView) add(row.profileId, (p) => fieldGrantCode(p, row.objectCode, row.fieldCode, 'view'));
    if (row.canEdit) add(row.profileId, (p) => fieldGrantCode(p, row.objectCode, row.fieldCode, 'edit'));
  }
  for (const row of await tx
    .select()
    .from(permissionProfileButtons)
    .where(inArray(permissionProfileButtons.profileId, ids)))
    add(row.profileId, (p) => buttonGrantCode(p, row.objectCode, row.buttonCode, row.level as ButtonLevel));
  for (const row of await tx
    .select()
    .from(permissionIdentityScopes)
    .where(inArray(permissionIdentityScopes.profileId, ids))) {
    if (row.targetKind !== 'entity' && row.targetKind !== 'datasource') continue;
    const kind = row.targetKind;
    const code = seeAllGrantCode(codeOf.get(row.profileId)!, row.appCode, kind, row.targetCode);
    (row.seeAll ? have : closed).get(codeOf.get(row.profileId)!)!.add(code);
  }
  return { have, closed };
}

/**
 * 已存在的授权项编码（方案 §4.2）。每次回补都执行：手工 / 不存在的身份整体“不可装”；其余身份先首次接管（没有 @ledger 时），
 * 再把“当前已有、台账没有”的项登记 adopted；返回 当前已有 ∪ 台账已登记 ∪ 父项被撤销的子项。
 * 这里会写台账（接管与持续登记），但不改任何权限、不写业务审计；命令 ID 留空（登记项的 existing 没有写上下文）。
 */
async function existingGrants(tx: Tx, _tenantId: string): Promise<ReadonlySet<string>> {
  const codes = STANDARD_PROFILES.map((profile) => profile.code);
  // 第一步：标准身份行按 id 顺序加锁（与租户保存对象权限的身份行锁同一把，串行）
  const profiles = await tx
    .select()
    .from(permissionProfiles)
    .where(and(eq(permissionProfiles.source, 'standard'), inArray(permissionProfiles.code, codes)))
    .orderBy(asc(permissionProfiles.id))
    .for('update');
  const standard = new Map(profiles.map((profile) => [profile.code, profile]));
  const { have, closed } = await currentGrantCodes(tx, profiles);
  const ledger = new Map(await readLedger(tx, STANDARD_GRANT_ENTRY));

  const adopted: string[] = [];
  const withheld: string[] = [];
  const result = new Set<string>();
  for (const [profileCode, items] of itemsByProfile) {
    const profile = standard.get(profileCode);
    if (!profile) {
      // 手工同编码身份 / 身份不存在：整身份不可装，不读不写其任何权限
      for (const item of items) result.add(item.code);
      continue;
    }
    const current = have.get(profileCode)!;
    const closedScopes = closed.get(profileCode)!;
    const marker = profileLedgerMarker(profileCode);
    const taken = ledger.has(marker);
    const withheldObjects = taken ? new Set<string>() : await takeoverWithheld(tx, profile, ledger, current, items);
    for (const item of items) {
      const registered = ledger.has(item.code);
      if (!registered && current.has(item.code)) adopted.push(item.code);
      else if (!registered && withheldObjects.has(objectOf(item) ?? '')) withheld.push(item.code);
    }
    if (!taken) adopted.push(marker);
    // 已有、台账已登记（含租户撤销的）、本次接管 withheld 的都算“已存在”；父项被撤销的子项另算不可装
    for (const item of items) {
      const settled = current.has(item.code) || ledger.has(item.code) || closedScopes.has(item.code);
      if (settled || withheldObjects.has(objectOf(item) ?? '')) result.add(item.code);
    }
    markRevokedChildren(items, current, ledger, withheldObjects, result);
  }
  const now = new Date();
  await recordLedger(tx, { entry: STANDARD_GRANT_ENTRY, codes: withheld, source: 'withheld', commandId: null, now });
  await recordLedger(tx, { entry: STANDARD_GRANT_ENTRY, codes: adopted, source: 'adopted', commandId: null, now });
  return result;
}

/** 父项被租户撤销（台账有、当前无）或同样不可装的子项也不可装，不补出没有父项的孤儿授权。 */
function markRevokedChildren(
  items: readonly GrantItem[],
  current: ReadonlySet<string>,
  ledger: ReadonlyMap<string, unknown>,
  withheldObjects: ReadonlySet<string>,
  result: Set<string>,
): void {
  const blocked = new Set<string>();
  for (const item of items) {
    const parent = grantParentCode(item.code, appOf);
    if (!parent) continue;
    const revoked = ledger.has(parent) && !current.has(parent);
    if (revoked || blocked.has(parent) || withheldObjects.has(objectOf(item) ?? '')) {
      blocked.add(item.code);
      result.add(item.code);
    }
  }
}

/**
 * 首次接管（方案 §5）：这个身份没有 @ledger，判断“当前没有的项”哪些可以放心补、哪些历史不足以判断，返回要 withheld 的对象。
 * 对象行不存在 → 确认没保存过（没有删除对象的路由）→ 补；身份 revision = 1 → 确认从未改过 → 补；
 * 否则该对象有 @modified 标记或在 set_object 审计里 → 确认改过（D1 = A，DEC-374）→ withheld；
 * 无标记无审计：审计条数 ≥ revision − 1（历史完整）→ 确认没改过 → 补，少于 → 审计已过保留期，历史不足以判断 → withheld。
 * 审计只读一次：完整性与“改过的对象集合”都出自同一个结果，清理发生在读取之前只会让结论从“完整”变成“不完整”。
 */
async function takeoverWithheld(
  tx: Tx,
  profile: PermissionProfile,
  ledger: ReadonlyMap<string, unknown>,
  current: ReadonlySet<string>,
  items: readonly GrantItem[],
): Promise<Set<string>> {
  if (profile.revision === 1) return new Set();
  const audited = await tx
    .select({ objectCode: sql<string | null>`${auditEvents.after}->>'objectCode'` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, 'permission_profile.set_object'),
        eq(auditEvents.objectType, 'permission_profile'),
        eq(auditEvents.objectId, profile.id),
      ),
    );
  await takeoverProbe.afterAuditRead?.(profile.code);
  const complete = audited.length >= profile.revision - 1;
  const modified = new Set(audited.flatMap((row) => (row.objectCode ? [row.objectCode] : [])));
  for (const code of ledger.keys()) {
    const ref = parseGrantCode(code);
    if (ref?.kind === 'modified' && ref.profileCode === profile.code) modified.add(ref.objectCode);
  }
  const withheld = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'object' || !current.has(item.code)) continue; // 对象行不存在：确认没保存过
    if (modified.has(item.objectCode) || !complete) withheld.add(item.objectCode);
  }
  return withheld;
}

/** 补装缺失授权项（方案 §4.3）：按身份分组，依赖顺序写、只增不删，按租户扩展目录重验，身份 revision + 1，记 install 与审计。 */
async function installGrants(tx: Tx, write: SeedWriteContext, missing: readonly string[]): Promise<SeedInstallResult> {
  const byProfile = new Map<string, GrantItem[]>();
  for (const code of missing) {
    const ref = parseGrantCode(code);
    if (!ref || ref.kind === 'ledger' || ref.kind === 'modified') continue;
    byProfile.set(ref.profileCode, [...(byProfile.get(ref.profileCode) ?? []), ref]);
  }
  const skipped: SeedSkip[] = [];
  for (const [profileCode, items] of byProfile) {
    const [profile] = await tx
      .select()
      .from(permissionProfiles)
      .where(and(eq(permissionProfiles.code, profileCode), eq(permissionProfiles.source, 'standard')))
      .for('update');
    if (profile) skipped.push(...(await installProfileGrants(tx, write, profile, items)));
  }
  return { skipped };
}

async function installProfileGrants(
  tx: Tx,
  write: SeedWriteContext,
  profile: PermissionProfile,
  all: GrantItem[],
): Promise<SeedSkip[]> {
  const items = all.filter((item) => item.kind !== 'seeAll');
  const objects = [...new Set(items.flatMap((item) => objectOf(item) ?? []))];
  const appsBefore = await profileApps(tx, profile.id);
  const before = await affectedObjects(tx, profile.id, objects);

  await writeGrants(tx, write.tenantId, profile.id, items);
  const seeAll = await installSeeAll(tx, write, profile.id, all);

  const appsAfter = await profileApps(tx, profile.id);
  const after = await affectedObjects(tx, profile.id, objects);
  await revalidate(tx, appsAfter, after, items);
  const [bumped] = await tx
    .update(permissionProfiles)
    .set({ revision: profile.revision + 1, updatedAt: write.now })
    .where(and(eq(permissionProfiles.id, profile.id), eq(permissionProfiles.revision, profile.revision)))
    .returning();
  if (!bumped) throw new Error(`标准身份 ${profile.code} 在补装授权时被并发修改`);
  const skippedCodes = new Set(seeAll.skipped.map((skip) => skip.code));
  await recordLedger(tx, {
    entry: STANDARD_GRANT_ENTRY,
    codes: all.map((item) => item.code).filter((code) => !skippedCodes.has(code)),
    source: 'install',
    commandId: write.commandId,
    now: write.now,
  });
  await auditAs(tx, write, {
    action: 'permission_profile.backfill_grants',
    objectType: 'permission_profile',
    objectId: profile.id,
    before: { apps: appsBefore, objects: before, revision: profile.revision },
    after: { apps: appsAfter, objects: after, seeAll: seeAll.installed, revision: bumped.revision },
  });
  return seeAll.skipped;
}

/**
 * 补预置看全部（D3 = A′，只有批准清单里的目标才有编码）：逐目标按固定顺序取范围锁（身份行锁已持有，顺序“身份 → 范围”）、
 * 复读范围行，仍不存在才按开通预置的同一写法插入（范围行 revision 1、范围版本、范围审计）；复读到行（租户抢先提交）就不覆盖。
 */
async function installSeeAll(
  tx: Tx,
  write: SeedWriteContext,
  profileId: string,
  items: readonly GrantItem[],
): Promise<{ installed: string[]; skipped: SeedSkip[] }> {
  const targets = items
    .flatMap((item) => (item.kind === 'seeAll' ? [item] : []))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
  const toInstall: PresetSeeAllTarget[] = [];
  const skipped: SeedSkip[] = [];
  for (const item of targets) {
    const key = { profileId, appCode: item.appCode, targetKind: item.targetKind, targetCode: item.targetCode };
    await lockIdentityScope(tx, write.tenantId, key);
    const [row] = await tx
      .select({ revision: permissionIdentityScopes.revision })
      .from(permissionIdentityScopes)
      .where(
        and(
          eq(permissionIdentityScopes.profileId, profileId),
          eq(permissionIdentityScopes.appCode, item.appCode),
          eq(permissionIdentityScopes.targetKind, item.targetKind),
          eq(permissionIdentityScopes.targetCode, item.targetCode),
        ),
      );
    if (row) skipped.push({ code: item.code, reason: 'SCOPE_EXISTS' });
    else toInstall.push({ appCode: item.appCode, targetKind: item.targetKind, targetCode: item.targetCode });
  }
  return { installed: await presetSeeAll(tx, write, profileId, toInstall), skipped };
}

const profileApps = async (tx: Tx, profileId: string) =>
  (await tx.select().from(permissionProfileApps).where(eq(permissionProfileApps.profileId, profileId)))
    .map((row) => row.appCode)
    .sort();

async function affectedObjects(tx: Tx, profileId: string, objects: readonly string[]): Promise<ObjectPermission[]> {
  const all = await loadObjectPermissions(tx, [profileId]);
  return all
    .filter((permission) => objects.includes(permission.objectCode))
    .sort((a, b) => a.objectCode.localeCompare(b.objectCode));
}

/**
 * 依赖顺序：应用 → 对象（数据操作、字段、按钮）。只增不删：应用只插入；对象把当前权限与本次新增项取并集后整体替换
 * （应用角色对权限子表只有增删权限没有 UPDATE，与 setObjectPermission 同一种写法），租户扩展字段等原有行原样带回。
 */
async function writeGrants(tx: Tx, tenantId: string, profileId: string, items: readonly GrantItem[]): Promise<void> {
  const apps = items.flatMap((item) => (item.kind === 'app' ? [item.appCode] : []));
  if (apps.length > 0)
    await tx
      .insert(permissionProfileApps)
      .values(apps.map((appCode) => ({ tenantId, profileId, appCode })))
      .onConflictDoNothing();
  for (const objectCode of new Set(items.flatMap((item) => objectOf(item) ?? []))) {
    const [current] = await loadObjectPermissions(tx, [profileId], objectCode);
    const own = items.filter((item) => objectOf(item) === objectCode);
    await replaceObjectRows(tx, tenantId, profileId, withGrants(objectCode, current, own));
  }
}

/** 当前对象权限（可能还没有对象行）并上本次新增的授权项；每个标志只会由 false 变 true。 */
function withGrants(
  objectCode: string,
  current: ObjectPermission | undefined,
  own: readonly GrantItem[],
): ObjectPermission {
  const added = (op: 'create' | 'update' | 'delete') => own.some((item) => item.kind === 'op' && item.op === op);
  const fields = new Map((current?.fields ?? []).map((field) => [field.fieldCode, { ...field }]));
  for (const item of own) {
    if (item.kind !== 'field') continue;
    const field = fields.get(item.fieldCode) ?? { fieldCode: item.fieldCode, view: false, edit: false };
    fields.set(item.fieldCode, { ...field, [item.mode]: true });
  }
  const buttons = new Map((current?.buttons ?? []).map((b) => [`${b.buttonCode}@${b.level}`, b]));
  for (const item of own)
    if (item.kind === 'button')
      buttons.set(`${item.buttonCode}@${item.level}`, { buttonCode: item.buttonCode, level: item.level });
  return {
    objectCode,
    dataOperations: {
      create: Boolean(current?.dataOperations.create) || added('create'),
      update: Boolean(current?.dataOperations.update) || added('update'),
      delete: Boolean(current?.dataOperations.delete) || added('delete'),
    },
    fields: [...fields.values()],
    buttons: [...buttons.values()],
  };
}

/**
 * 写完后按租户扩展目录重验受影响对象并核应用边界，不合法即抛错、整笔回滚。租户扩展字段（custom:<id>、field:<code>）
 * 的原有授权原样保留：扩展目录不含它们时（超过 TENANT_FIELD_LIMIT 一个都不追加）不参与校验，只校验本次新增项。
 */
async function revalidate(
  tx: Tx,
  apps: readonly string[],
  after: readonly ObjectPermission[],
  items: readonly GrantItem[],
) {
  const addedFields = new Set(
    items.flatMap((item) => (item.kind === 'field' ? [`${item.objectCode}/${item.fieldCode}`] : [])),
  );
  const addedButtons = new Set(
    items.flatMap((item) => (item.kind === 'button' ? [`${item.objectCode}/${item.buttonCode}@${item.level}`] : [])),
  );
  for (const permission of after) {
    const definition = (await tenantObjectCatalog(tx, objectCatalog, permission.objectCode)).get(permission.objectCode);
    if (!definition) throw new Error(`标准身份引用了未登记的对象 ${permission.objectCode}`);
    const known = new Set(definition.fields.map((field) => field.code));
    const checked = {
      ...permission,
      fields: permission.fields.filter(
        (field) => known.has(field.fieldCode) || addedFields.has(`${permission.objectCode}/${field.fieldCode}`),
      ),
      buttons: permission.buttons.filter(
        (button) =>
          definition.buttons.some((b) => b.code === button.buttonCode && b.level === button.level) ||
          addedButtons.has(`${permission.objectCode}/${button.buttonCode}@${button.level}`),
      ),
    };
    const violations = validateObjectPermission(definition, checked);
    if (violations.length > 0) throw new Error(`补装后的对象权限不合法：${JSON.stringify(violations)}`);
    if (!isWithinProfileApps(definition, apps)) throw new Error(`对象 ${permission.objectCode} 不在身份登记的应用内`);
  }
}
