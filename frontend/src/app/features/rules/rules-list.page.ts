import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { AlertRule, describeCondition } from '../../core/rules/rules.models';
import { RulesStore } from '../../core/rules/rules.store';
import { ConfirmDialog } from './confirm-dialog';

@Component({
  selector: 'fp-rules-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule],
  styleUrl: './rules-list.page.scss',
  template: `
    <header class="head">
      <h1>Alert rules</h1>
      @if (auth.isOperator()) {
        <a mat-flat-button routerLink="/rules/new">New rule</a>
      }
    </header>

    @for (f of store.failures(); track f.id) {
      <div class="failure" role="alert">
        <p>
          Could not {{ f.operation === 'delete' ? 'delete' : 'save' }} “{{ f.name }}”:
          {{ f.message }}
          The list was restored.
        </p>
        <button mat-stroked-button type="button" (click)="store.retry(f.id)">Retry</button>
        <button mat-button type="button" (click)="store.dismiss(f.id)">Dismiss</button>
      </div>
    }

    @switch (store.loadState()) {
      @case ('error') {
        <p role="alert">Could not load the rules.</p>
        <button mat-stroked-button type="button" (click)="store.load()">Retry</button>
      }
      @case ('ready') {
        @if (store.rules().length === 0) {
          <p>There are no alert rules yet.</p>
        } @else {
          <table class="rules">
            <caption class="sr-only">
              Alert rules
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Conditions (all must hold)</th>
                @if (auth.isOperator()) {
                  <th scope="col"><span class="sr-only">Actions</span></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (rule of store.rules(); track rule.id) {
                <tr [class.is-pending]="rule.pending">
                  <th scope="row">
                    {{ rule.name }}
                    @if (rule.pending) {
                      <span class="badge">Saving…</span>
                    }
                  </th>
                  <td>
                    <ul>
                      @for (c of rule.conditions; track $index) {
                        <li>{{ describe(c) }}</li>
                      }
                    </ul>
                  </td>
                  @if (auth.isOperator()) {
                    <td class="actions">
                      @if (!rule.pending) {
                        <a
                          mat-stroked-button
                          [routerLink]="['/rules', rule.id]"
                          [attr.aria-label]="'Edit ' + rule.name"
                          >Edit</a
                        >
                        <button
                          mat-button
                          type="button"
                          (click)="confirmDelete(rule)"
                          [attr.aria-label]="'Delete ' + rule.name"
                        >
                          Delete
                        </button>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        }
      }
      @default {
        <p>Loading rules…</p>
      }
    }
  `,
})
export class RulesListPage {
  protected readonly store = inject(RulesStore);
  protected readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);

  protected readonly describe = describeCondition;

  protected confirmDelete(rule: AlertRule): void {
    this.dialog
      .open(ConfirmDialog, {
        data: {
          title: `Delete “${rule.name}”?`,
          message: 'The rule stops firing immediately. This cannot be undone.',
          confirmLabel: 'Delete rule',
          cancelLabel: 'Cancel',
        },
      })
      .afterClosed()
      .pipe(filter((confirmed) => confirmed === true))
      .subscribe(() => this.store.remove(rule.id));
  }
}
