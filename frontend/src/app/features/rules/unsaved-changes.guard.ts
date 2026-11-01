import { inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { CanDeactivateFn } from '@angular/router';
import { map } from 'rxjs';
import { ConfirmDialog } from './confirm-dialog';

export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

/** Leaving a form with unsaved edits asks first. Cancel keeps the user on the form. */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component.hasUnsavedChanges()) return true;
  return inject(MatDialog)
    .open(ConfirmDialog, {
      data: {
        title: 'Discard unsaved changes?',
        message:
          'You have edited this rule but not saved it. If you leave now, your changes are lost.',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
      },
    })
    .afterClosed()
    .pipe(map((result) => result === true));
};
