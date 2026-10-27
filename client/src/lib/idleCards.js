// Idle job cards on Job Cards and the Live Floor — live cards nobody has touched
// for IDLE_DAYS. The rule lives on the server (server/src/idle-cards.js); a
// screen that sends `?idle=hide` gets the active cards plus a count, and asks for
// the full list again while "Show" is on. The choice is remembered per screen,
// per browser — a convenience, so it lives in storage and survives nothing more.
import { storage } from './safeStorage.js';

export const IDLE_DAYS = 14; // twin of server/src/idle-cards.js

export function readShowIdle(key) {
  try { return storage.getItem(key) === '1'; } catch { return false; }
}

export function writeShowIdle(key, on) {
  try { storage.setItem(key, on ? '1' : '0'); } catch { /* memory rung: forgets on reload */ }
}

// The Live Floor's bands merge sorting and pasting into one Sort & Paste band.
export function idleForBand(idle, section, merged = false) {
  const s = idle?.sections || {};
  return merged ? (s.sorting || 0) + (s.pasting || 0) : (s[section] || 0);
}
