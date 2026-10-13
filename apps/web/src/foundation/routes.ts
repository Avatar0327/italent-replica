import { contractRoute } from '../contracts/route.js';
import { ui } from './messages.js';

export type AppId = keyof typeof ui.routes;
export interface AppRoute {
  id: AppId;
  path: string;
  label: string;
  group: keyof typeof ui.groups;
  objectCode?: string;
}
const route = (id: AppId, group: AppRoute['group'], objectCode?: string): AppRoute => ({
  id,
  path: `/${id}`,
  label: ui.routes[id],
  group,
  objectCode,
});

// 页面契约注册点。菜单层级的 L2 适配在 demo-stubs/navigation.ts；这里不授予权限。
export const APP_ROUTES: readonly AppRoute[] = [
  route('org', 'people', 'TenantBase.Organization'),
  route('job', 'people', 'TenantBase.JobPost'),
  route('staff', 'people', 'TenantBase.Employee'),
  route('transfer', 'people', 'TenantBase.EmploymentRecord'),
  route('approval', 'work'),
  route('self', 'work'),
  route('manager', 'work'),
  route('settings', 'settings'),
  route('talent', 'talent', 'TalentCenter.DimensionLibrary'),
  route('qualification', 'talent', 'Qualification.EmploymentCategory'),
  route('evaluation', 'talent', 'TEvaluation.EvaluationActivity'),
  route('survey360', 'talent', 'Survey360.Activity'),
  route('talent-review', 'talent', 'TalentReview.Project'),
  route('succession', 'talent', 'Succession.Map'),
  route('idp', 'talent', 'IDP.IDPTemplate'),
];

export function appRoute(path: string) {
  return [...APP_ROUTES, contractRoute].find((item) => path === item.path || path.startsWith(`${item.path}/`));
}
export function legacyTarget(path: string, search = '', hash = ''): string | null {
  const target = ({ '/': '/transfer', '/jobs': '/job', '/account': '/settings/account' } as Record<string, string>)[
    path
  ];
  return target ? `${target}${search}${hash}` : null;
}
