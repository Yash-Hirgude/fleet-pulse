import { Injectable, inject, signal } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';

const STORAGE_KEY = 'fleet-pulse.settings';

export interface Settings {
  notifyOnFiring: boolean;
  notificationSeconds: number;
}

/** User preferences, kept in localStorage. Nothing here is sensitive. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly defaults: Settings = {
    notifyOnFiring: true,
    notificationSeconds: inject(APP_CONFIG).ui.defaultNotificationSeconds,
  };
  private readonly state = signal<Settings>(this.read());

  readonly settings = this.state.asReadonly();

  save(next: Settings): void {
    this.state.set({ ...next });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: the setting just does not survive a reload */
    }
  }

  private read(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...this.defaults };
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        notifyOnFiring:
          typeof parsed.notifyOnFiring === 'boolean'
            ? parsed.notifyOnFiring
            : this.defaults.notifyOnFiring,
        notificationSeconds:
          typeof parsed.notificationSeconds === 'number' &&
          parsed.notificationSeconds >= 2 &&
          parsed.notificationSeconds <= 30
            ? parsed.notificationSeconds
            : this.defaults.notificationSeconds,
      };
    } catch {
      return { ...this.defaults };
    }
  }
}
