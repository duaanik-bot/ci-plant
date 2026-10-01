// The status a line shows on the sales-facing screens — Track, the Status Sheet
// and Sales Pendency. ONE spelling, so the three agree with each other and with
// the pendency floor buckets (pendencyFloor, routes/orders.js).
//
// A carton made in parts has no job card of its own until its pasting card
// (carton-parts.js), and its own line status stays 'pending' while its parts
// are made. Until then it is only as far along as its least-advanced part:
// 'in_production' once EVERY part has a card (a die-cut, 'split' one counts),
// otherwise the lowest planning status among its parts — a part still waiting
// to be planned makes the carton wait with it. With its pasting card it is its
// own line again. Every other line reads exactly ol.status.
//
// `ol` is the order line's alias in the query this is spliced into.
export const CARTON_STATUS_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM job_cards xc WHERE xc.order_line_id = ol.id)
    OR NOT EXISTS (SELECT 1 FROM order_lines xp WHERE xp.part_of_line_id = ol.id) THEN ol.status
  WHEN NOT EXISTS (SELECT 1 FROM order_lines xp WHERE xp.part_of_line_id = ol.id
                     AND NOT EXISTS (SELECT 1 FROM job_cards xj WHERE xj.order_line_id = xp.id)) THEN 'in_production'
  WHEN EXISTS (SELECT 1 FROM order_lines xp WHERE xp.part_of_line_id = ol.id AND xp.status = 'pending') THEN 'pending'
  WHEN EXISTS (SELECT 1 FROM order_lines xp WHERE xp.part_of_line_id = ol.id AND xp.status = 'planned') THEN 'planned'
  WHEN EXISTS (SELECT 1 FROM order_lines xp WHERE xp.part_of_line_id = ol.id AND xp.status = 'ready') THEN 'ready'
  ELSE ol.status
END`;
