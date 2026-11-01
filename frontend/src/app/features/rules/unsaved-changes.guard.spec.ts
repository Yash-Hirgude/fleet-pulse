import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { Observable, firstValueFrom, of } from 'rxjs';
import { HasUnsavedChanges, unsavedChangesGuard } from './unsaved-changes.guard';

describe('unsavedChangesGuard', () => {
  const open = vi.fn();

  function run(dirty: boolean) {
    return TestBed.runInInjectionContext(() =>
      unsavedChangesGuard(
        { hasUnsavedChanges: () => dirty } as HasUnsavedChanges,
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
        {} as RouterStateSnapshot,
      ),
    );
  }

  beforeEach(() => {
    open.mockReset();
    TestBed.configureTestingModule({ providers: [{ provide: MatDialog, useValue: { open } }] });
  });

  it('lets the user leave a clean form without asking', () => {
    expect(run(false)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('asks for confirmation when there are unsaved changes, and leaves only if confirmed', async () => {
    open.mockReturnValue({ afterClosed: () => of(true) });
    expect(await firstValueFrom(run(true) as Observable<boolean>)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('stays on the form when the user cancels, or dismisses the dialog', async () => {
    open.mockReturnValue({ afterClosed: () => of(false) });
    expect(await firstValueFrom(run(true) as Observable<boolean>)).toBe(false);
    open.mockReturnValue({ afterClosed: () => of(undefined) });
    expect(await firstValueFrom(run(true) as Observable<boolean>)).toBe(false);
  });
});
