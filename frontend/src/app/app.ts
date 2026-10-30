import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'fp-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {}
