const MORE_ROOTS = new Set([
  '/categorias',
  '/tipo-de-cambio',
  '/presupuestos',
  '/metas',
  '/deudas',
  '/recurrentes',
  '/perfil',
  '/ajustes',
]);

const LIST_DETAIL_ROOTS = new Set(['/movimientos', '/presupuestos', '/metas', '/deudas']);
const CATEGORY_CHILDREN = new Set(['nueva', 'archivadas']);

/** Screen a route hangs from, or null for tab roots (RF-M2-13). */
export function parentOf(pathname: string, options: { desktop: boolean }): string | null {
  const segments = pathname.split('/').filter(Boolean);
  const root = `/${segments[0] ?? ''}`;
  const rest = segments.slice(1);

  if (segments.length === 0) return null;

  if (rest.length === 0) {
    return !options.desktop && MORE_ROOTS.has(root) ? '/mas' : null;
  }

  if (LIST_DETAIL_ROOTS.has(root)) return rest.length === 1 ? root : null;

  switch (root) {
    case '/cuentas':
      if (rest.length === 1) return '/cuentas';
      return rest.length === 2 && rest[1] === 'editar' ? `/cuentas/${rest[0]}` : null;
    case '/categorias':
      if (rest.length === 1 && CATEGORY_CHILDREN.has(rest[0] ?? '')) return '/categorias';
      return rest.length === 2 && rest[1] === 'editar' ? '/categorias' : null;
    case '/perfil':
      return rest.length === 1 && rest[0] === 'eliminar' ? '/perfil' : null;
    case '/ajustes':
      return '/ajustes';
    default:
      return null;
  }
}
