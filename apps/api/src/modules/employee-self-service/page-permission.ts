/**
 * 员工“发展通道”页面权限判定（C1-2b，DEC-399② / DEC-402①④；契约 §3.2）。权限模型没有页面权限类型，页面用应用级载体对象
 * Qualification.Pages 上的 app_page 按钮表示。C1-6 的本人入口先确认绑定员工，再调这里；无权时由 C1-6 返回
 * 403 PAGE_PERMISSION_REQUIRED（本文件只给判定）。结果是下面两项的并集：
 * 1. 员工身份（按编码找行，不看 source）：没有这一行、或这一行没有载体对象行 → 默认授予（DEC-402①，缺载体行时默认显示、不加
 *    关闭开关）；有对象行 → 看按钮行里有没有该页面；
 * 2. 用户自己持有的身份：任一有效授权的身份在 Qualification 应用内勾了该页面（原站页面权限按身份并集）。
 * 只看当前租户的行（tx 是租户事务，RLS 隔离）：别的租户里的身份不参与。不看任职资格数据范围：关系入口。
 */
import { eq, permissionProfiles, type Tx } from '@italent/db';
import { EMPLOYEE_SELF_SERVICE_CODE, type EmployeePage, QUALIFICATION_APP, QUALIFICATION_PAGES } from '@italent/domain';
import { loadGrantedObjectPermissions, loadObjectPermissions } from '../permission/subject.js';
import { boundEmployee } from './access.js';

export async function employeePageGranted(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly userId: string },
  page: EmployeePage,
): Promise<boolean> {
  await boundEmployee(tx, ctx);
  const has = (buttons: readonly { buttonCode: string; level: string }[]) =>
    buttons.some((b) => b.buttonCode === page && b.level === 'app_page');

  const [employee] = await tx
    .select({ id: permissionProfiles.id })
    .from(permissionProfiles)
    .where(eq(permissionProfiles.code, EMPLOYEE_SELF_SERVICE_CODE));
  if (!employee) return true;
  const [carrier] = await loadObjectPermissions(tx, [employee.id], QUALIFICATION_PAGES.code);
  if (!carrier || has(carrier.buttons)) return true;

  const own = await loadGrantedObjectPermissions(tx, ctx.userId, QUALIFICATION_PAGES.code);
  return own.some((permission) => permission.profileApps.includes(QUALIFICATION_APP) && has(permission.buttons));
}
