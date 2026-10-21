import type { ResetSettingsInput, UpdateSettingsInput } from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { Clock } from '../../application/ports/clock.js';
import type { SettingsService } from '../../application/services/settings.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { SettingsPresenter } from '../presenters/settings.presenter.js';

export interface SettingsControllerDeps {
  settingsService: SettingsService;
  clock: Pick<Clock, 'now'>;
}

const sessionOf = (req: Request): SessionContext => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth;
};

export interface SettingsController {
  get: RequestHandler;
  update: RequestHandler;
  reset: RequestHandler;
}

/** Handlers of `/api/settings` (plan §4.9.2). The user always comes from the session. */
export function createSettingsController({
  settingsService,
  clock,
}: SettingsControllerDeps): SettingsController {
  return {
    async get(req, res) {
      const settings = await settingsService.get(sessionOf(req).userId);
      res.status(200).json(SettingsPresenter.toDto(settings));
    },

    async update(req, res) {
      const body = req.body as UpdateSettingsInput;
      const settings = await settingsService.update(sessionOf(req).userId, {
        numberFormat: body.numberFormat,
        dateFormat: body.dateFormat,
        weekStart: body.weekStart,
        theme: body.theme,
        sidebarCollapsed: body.sidebarCollapsed,
        defaultAccountId: body.defaultAccountId,
        alwaysShowNote: body.alwaysShowNote,
        dashboardBlocks: body.dashboardBlocks,
        favoriteCategories: body.favoriteCategories,
      });
      res.status(200).json(SettingsPresenter.toDto(settings));
    },

    async reset(req, res) {
      const { section } = req.body as ResetSettingsInput;
      await settingsService.reset({ userId: sessionOf(req).userId, now: clock.now() }, section);
      res.status(204).end();
    },
  };
}
