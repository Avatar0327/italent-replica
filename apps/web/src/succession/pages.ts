import { lazyPage, type ModulePages } from '../foundation/page-registry.js';
import { settingsMenu } from './rules.js';

const SuccessionPage = lazyPage('SuccessionPage', () => import('./SuccessionPage.js'));
const SuccessionSettingsPage = lazyPage('SuccessionSettingsPage', () => import('./SettingsPage.js'));
export const pages: ModulePages = {
  apps: [
    {
      app: 'succession',
      label: '继任管理',
      group: 'talent',
      objectCode: 'Succession.Map',
      page: SuccessionPage,
      children: (snapshot) => settingsMenu(snapshot),
    },
  ],
  routes: [
    { path: '/succession/manage', page: SuccessionPage },
    { path: '/succession/settings/:section', page: SuccessionSettingsPage },
  ],
};
