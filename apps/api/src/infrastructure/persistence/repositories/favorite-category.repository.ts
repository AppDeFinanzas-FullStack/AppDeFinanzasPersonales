import type { FavoriteCategoryRepository } from '../../../application/ports/repositories.js';
import type { TransactionClient } from '../unit-of-work.js';

/** Prisma implementation of the favorite categories, bound to the transaction `tx`. */
export function createFavoriteCategoryRepository(tx: TransactionClient): FavoriteCategoryRepository {
  return {
    async replace(userId, kind, ids) {
      await tx.$executeRaw`
        DELETE FROM favorite_category
         WHERE user_id = ${userId}::uuid AND kind = ${kind}::category_kind`;
      if (ids.length === 0) {
        return;
      }
      await tx.$executeRaw`
        INSERT INTO favorite_category (user_id, category_id, kind, position)
        SELECT ${userId}::uuid, f.id, ${kind}::category_kind, f.position::smallint
          FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS f(id, position)`;
    },
  };
}
