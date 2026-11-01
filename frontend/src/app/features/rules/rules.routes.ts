import { Routes } from '@angular/router';
import { RuleFormPage } from './rule-form.page';
import { RulesListPage } from './rules-list.page';
import { unsavedChangesGuard } from './unsaved-changes.guard';

/** Lazy-loaded as one chunk: nothing here is in the initial bundle. */
export const RULES_ROUTES: Routes = [
  { path: '', title: 'Rules', component: RulesListPage },
  { path: 'new', title: 'New rule', component: RuleFormPage, canDeactivate: [unsavedChangesGuard] },
  {
    path: ':id',
    title: 'Edit rule',
    component: RuleFormPage,
    canDeactivate: [unsavedChangesGuard],
  },
];
