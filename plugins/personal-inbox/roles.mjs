// STATUS: not used by any program yet. The plugin and the scripts work with the default agent IDs listed below as plain strings;
// only scripts/sync-shared-rules.py reads the "roles" override of config/crew.json. This module keeps the defaults and the helper
// functions ready for the step where programs ask the role table instead of comparing IDs (docs: configuration.md, section 3).
// Role table: which agentId plays which duty. The defaults match the reference deployment
// (docs/*/roles.md); override them with "roles" in config/crew.json if you rename agents.
import { crew } from './crew-config.mjs';

export const DEFAULT_ROLES = {
  controller: 'main',
  desktop: 'desktop',
  taskAuditor: 'task-auditor',
  systemAuditor: 'system-auditor',
  diary: 'diary',
  standby: ['standby-a', 'standby-b'],
  workerPrefix: 'worker-',
};

export const ROLES = { ...DEFAULT_ROLES, ...(crew.roles ?? {}) };

export const isController = (id) => id === ROLES.controller;
export const isDesktop = (id) => id === ROLES.desktop;
export const isTaskAuditor = (id) => id === ROLES.taskAuditor;
export const isSystemAuditor = (id) => id === ROLES.systemAuditor;
export const isAuditRole = (id) => isTaskAuditor(id) || isSystemAuditor(id);
export const isDiary = (id) => id === ROLES.diary;
export const isStandby = (id) => ROLES.standby.includes(id);
export const isWorker = (id) => typeof id === 'string' && id.startsWith(ROLES.workerPrefix);
