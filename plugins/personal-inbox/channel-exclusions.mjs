// Channel exclusions: channels where the completion-notice line and the pending-approval reminder must stay silent.
// Sources: config/crew.json (excludedChannels) plus the optional channel-exclusions.json next to this file (path built from the project root,
// because OpenClaw copies installed plugins to a temp dir). Re-read on every trigger (no cache). Unreadable or malformed file: treated as empty;
// the workshop channel is always excluded from completion notices.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { crew } from './crew-config.mjs';
export const WORKSHOP_CHANNEL_ID = crew.channels.workshop; // workshop channel (same ID as in pending-ledger.mjs)
export const exclusionsPath = (syncRoot) => (syncRoot ? join(syncRoot, 'plugins', 'personal-inbox', 'channel-exclusions.json') : null);

export function loadChannelExclusions(syncRoot, read = (p) => readFileSync(p, 'utf8')) {
  let completion = [], reminder = [];
  try {
    const path = exclusionsPath(syncRoot);
    if (path) {
      const data = JSON.parse(read(path));
      const ids = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => /^\d{5,}$/.test(x)) : []);
      completion = ids(data?.completionNotice); reminder = ids(data?.approvalReminder);
    }
  } catch { /* 读不到或写坏：空表 */ }
  const fromCrew = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return { completion: new Set([...completion, ...fromCrew(crew.excludedChannels?.completionNotice), WORKSHOP_CHANNEL_ID]), reminder: new Set([...reminder, ...fromCrew(crew.excludedChannels?.approvalReminder)]) };
}
export const isCompletionExcluded = (syncRoot, channelId, read) => loadChannelExclusions(syncRoot, read).completion.has(String(channelId ?? ''));
export const isReminderExcluded = (syncRoot, channelId, read) => loadChannelExclusions(syncRoot, read).reminder.has(String(channelId ?? ''));
