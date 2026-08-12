// How a board sheet count is SHOWN as packets. One spelling, read by every
// screen that prints the pair.
//
// The plant counts, buys and hands over board in PACKETS; the ledger transacts
// in SHEETS, because cutting and planning are sheet-denominated. So a screen
// naming a board sheet count carries its packet equivalent beside it and nobody
// converts in their head. RM stock leads with packets and puts sheets under
// them; the station queue does the reverse, because sheets are the number the
// floor works to. Same pair either way — and this file is why it is the same
// ARITHMETIC either way.
//
// Deliberately NOT in boardMath.js. That module is a verbatim twin of
// server/src/board-math.js with a parity test on its exported surface
// (board-math.test.js), and a server module has no business formatting an en-IN
// string. The maths lives there; how it reads lives here.
import { packets } from './boardMath.js';

// A real zero is preserved as zero: a job that has drawn nothing has 0 packets,
// which is a different fact from a board whose packet size nobody has recorded
// — that returns null, so the caller can print nothing rather than a confident,
// wrong zero. Leftover and one-off masters legitimately carry no
// sheets_per_packet.
//
// `null` sheets coerces to 0 and lands in the real-zero arm. Spotting "unknown"
// is therefore the CALLER's job: the station queue tests its figure for null
// before it renders a packet line at all.
export const packetsOf = (b, sheets) => (+sheets === 0 ? 0 : packets(b, sheets));

// Packets stay FRACTIONAL: 250 sheets of a 100-sheet pack is 2.5 packets, not 3.
// Rounding up invents stock that is not on the shelf; rounding down hides sheets
// the floor may draw. Two decimals — a packet count is read at a glance, not
// audited to the sheet, and the sheet figure it sits beside is exact anyway.
export const packetText = p => (p == null ? '—' : (+p).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
