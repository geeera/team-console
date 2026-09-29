import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('@console/pages/hello').then((m) => m.HelloPage),
  },
  { path: '**', redirectTo: '' },
];
