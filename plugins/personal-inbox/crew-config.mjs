// Central deployment config loader.
// Every program reads owner/bot/channel IDs, time zone, locale and paths from ONE file
// (config/crew.json), so nothing about your own deployment is hard-coded in the code.
// Lookup order: $SOLOFLEET_CONFIG, <repo>/config/crew.json, <repo>/config/crew.example.json.
// OpenClaw copies installed plugins to a temp dir, so for the installed plugin set
// SOLOFLEET_CONFIG in the Gateway environment.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

export function configPath(env = process.env) {
  const candidates = [env.SOLOFLEET_CONFIG, join(REPO_ROOT, 'config', 'crew.json'), join(REPO_ROOT, 'config', 'crew.example.json')];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const DEFAULTS = {
  owner: { userId: '', title: 'the owner' },
  guildId: '',
  channels: { workshop: '', approval: '', lounge: '', diary: '' },
  excludedChannels: { completionNotice: [], approvalReminder: [] },
  bots: {},
  timezone: 'UTC',
  locale: 'en',
  replyLanguage: 'English',
  paths: { dataRoot: '', workspaceRoot: '', projectRoot: '', nodeBin: 'node', openclawBin: 'openclaw', openclawHome: '~/.openclaw', openclawInstallDir: '', codexbarBin: '', claudeBin: '' },
  auditAreas: { review: '', roster: '', backup: '' },
  jobs: {},
  models: {},
  attachCard: { quotaSource: 'off', modelFamilies: ['sonnet', 'opus', 'haiku', 'fable'], scopedWeeklyFamily: 'fable' },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = k in base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null && v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k], v) : v;
  return out;
}

export function loadCrew(path = configPath()) {
  let raw = {};
  if (path) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { raw = {}; }
  }
  const c = merge(DEFAULTS, raw);
  c.paths = { ...c.paths, openclawHome: expandHome(c.paths.openclawHome), projectRoot: c.paths.projectRoot || REPO_ROOT };
  c.sourcePath = path;
  return c;
}

export const crew = loadCrew();

export const ownerId = () => crew.owner.userId;
export const ownerMention = () => `<@${crew.owner.userId}>`;
export const botId = (agentId) => crew.bots?.[agentId]?.userId ?? '';
export const botMention = (agentId) => `<@${botId(agentId)}>`;
export const guildId = () => crew.guildId;
export const channelId = (name) => crew.channels?.[name] ?? '';
