// What Print Planning asks /print-planning for, by the tab on screen.
//
// The Board tab reads the printed runs only for each lane's "N sh today", so it
// asks for `?completed=today` — a 36-hour window the page's own isToday filter
// narrows to the browser's day. The Completed tab lists the whole 60 days and
// asks for the legacy answer. On live prod that was 346 KB → ~85 KB on every
// board refresh, and the board refreshes on every realtime change.
//
// load() picks the path from the tab ref at the moment it runs, so a realtime
// tick or the 30 s fallback always asks for the scope on screen — two scopes
// can never take turns overwriting the one `completed` list.
export const printPlanningPath = tab =>
  tab === 'completed' ? '/print-planning' : '/print-planning?completed=today';

// The Completed badge: the served 60-day count when only today's rows came,
// else the length of the full list that did.
export const completedBadgeCount = d =>
  d?.completed_count ?? (Array.isArray(d?.completed) ? d.completed.length : 0);
