import type { UpdateMeInput } from '@finanzas/contracts';
import type { Request, RequestHandler } from 'express';

import { AppError } from '../../application/errors.js';
import type { MeService } from '../../application/services/me.service.js';
import type { SessionContext } from '../middlewares/require-session.js';
import { MePresenter, type Release } from '../presenters/me.presenter.js';

export interface MeControllerDeps {
  meService: MeService;
  release: Release;
}

const sessionOf = (req: Request): SessionContext => {
  if (req.auth === undefined) {
    throw new AppError('SESSION_EXPIRED');
  }
  return req.auth;
};

export interface MeController {
  get: RequestHandler;
  update: RequestHandler;
  deleteAccount: RequestHandler;
}

/** Handlers of `/api/me` (plan §4.1.2). The user always comes from the session (RN-09). */
export function createMeController({ meService, release }: MeControllerDeps): MeController {
  return {
    async get(req, res) {
      const profile = await meService.get(sessionOf(req).userId);
      res.status(200).json(MePresenter.toDto(profile, release));
    },

    async update(req, res) {
      const body = req.body as UpdateMeInput;
      const profile = await meService.update(sessionOf(req).userId, {
        name: body.name,
        timezone: body.timezone,
      });
      res.status(200).json(MePresenter.toDto(profile, release));
    },

    async deleteAccount(req, res) {
      const body = req.body as { password: string; confirmation: string };
      await meService.deleteAccount({
        userId: sessionOf(req).userId,
        password: body.password,
        confirmation: body.confirmation,
      });
      res.status(204).end();
    },
  };
}
