import { uuidv7 } from 'uuidv7';

import type {
  UndoAction,
  UndoActionRepository,
  UndoKind,
} from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation over `undo_action`, always filtered by the user of the transaction (RN-09). */
export function createUndoActionRepository(
  tx: TransactionClient,
  userId: string,
): UndoActionRepository {
  return {
    async create(kind: UndoKind, payload: unknown): Promise<{ id: string; expiresAt: Date }> {
      const id = uuidv7();
      const rows = await tx.$queryRaw<{ expiresAt: Date }[]>`
        INSERT INTO undo_action (id, user_id, kind, payload, expires_at)
        VALUES (${id}::uuid, ${userId}::uuid, ${kind}::undo_kind,
                ${JSON.stringify(payload)}::jsonb, now() + interval '12 seconds')
        RETURNING expires_at AS "expiresAt"`;
      const row = rows[0];
      if (!row) throw new Error('undo_action insert returned no row');
      return { id, expiresAt: row.expiresAt };
    },

    async consume(id: string): Promise<UndoAction | null> {
      const rows = await tx.$queryRaw<{ kind: UndoKind; payload: unknown }[]>`
        UPDATE undo_action SET consumed_at = now()
         WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
           AND consumed_at IS NULL AND expires_at > now()
        RETURNING kind::text AS kind, payload`;
      const row = rows[0];
      return row ? { kind: row.kind, payload: row.payload } : null;
    },
  };
}
