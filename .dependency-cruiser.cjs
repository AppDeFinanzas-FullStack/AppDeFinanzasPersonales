/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'presentation-not-to-infrastructure',
      comment: 'Presentation must not depend on infrastructure (ADR-19).',
      severity: 'error',
      from: { path: '^apps/api/src/presentation' },
      to: { path: '^apps/api/src/infrastructure' },
    },
    {
      name: 'application-not-to-presentation',
      comment: 'Application must not depend on presentation (ADR-19).',
      severity: 'error',
      from: { path: '^apps/api/src/application' },
      to: { path: '^apps/api/src/presentation' },
    },
    {
      name: 'application-not-to-infrastructure',
      comment: 'Application depends on its own ports, never on infrastructure (ADR-19).',
      severity: 'error',
      from: { path: '^apps/api/src/application' },
      to: { path: '^apps/api/src/infrastructure' },
    },
    {
      name: 'application-no-framework',
      comment: 'Application must not import express, @prisma/client or better-auth.',
      severity: 'error',
      from: { path: '^apps/api/src/application' },
      to: { path: '(^|/)node_modules/(express|@prisma/client|better-auth)(/|$)' },
    },
    {
      name: 'domain-pure',
      comment: 'Domain only depends on itself, decimal.js and date-fns.',
      severity: 'error',
      from: { path: '^apps/api/src/domain' },
      to: {
        pathNot: [
          '^apps/api/src/domain',
          '^packages/domain',
          '(^|/)node_modules/(decimal\\.js|date-fns|@finanzas/domain)(/|$)',
        ],
      },
    },
    {
      name: 'infrastructure-not-to-presentation',
      comment: 'Infrastructure must not depend on presentation (ADR-19).',
      severity: 'error',
      from: { path: '^apps/api/src/infrastructure' },
      to: { path: '^apps/api/src/presentation' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies are not allowed.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
