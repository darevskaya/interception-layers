/**
 * Presentation only: arrows, alignment, truncation, colour.
 *
 * Nothing here knows about browsers or protocols — the examples keep all of
 * that themselves. Two levels of output:
 *
 *   step()  always prints. One semantic beat of what the example just did.
 *   wire()  prints only under TRACE=1. One raw protocol frame.
 *
 * Run any example with TRACE=1 to see the wire log:
 *   TRACE=1 node examples/raw-cdp-intercept.js
 */
export const TRACING = process.env.TRACE === '1';

// Colour is skipped when the output is piped or NO_COLOR is set, so logs and
// `grep` see clean text.
const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = code => text => (COLOUR ? `\x1b[${code}m${text}\x1b[0m` : String(text));

const dim = paint('2');
const cyan = paint('36');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');

const LABEL_WIDTH = 22;

/** One line of JSON, short enough to read at a glance. */
export function compact(value, max = 68) {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A beat in the story: what the example did, in its own vocabulary. */
export function step(label, detail = '') {
  console.log(`  ${cyan('▶')} ${label.padEnd(LABEL_WIDTH)} ${detail}`);
}

/** An aside — something skipped, or a detail that is not a beat. */
export function note(text) {
  console.log(dim(`    · ${text}`));
}

const MARKERS = {
  out: () => cyan('→'),
  in: () => dim('←'),
  event: () => yellow('⚡'),
};

/** One protocol frame. Silent unless TRACE=1. */
export function wire(direction, label, detail) {
  if (!TRACING) return;
  console.log(`  ${MARKERS[direction]()} ${label.padEnd(LABEL_WIDTH)} ${dim(compact(detail))}`);
}

/** A proportional bar, for comparing two measurements. */
export function bar(label, value, max, unit = 'ms', width = 32) {
  const filled = Math.max(1, Math.round((value / max) * width));
  console.log(`  ${label.padEnd(14)} ${'█'.repeat(filled).padEnd(width)} ${value} ${unit}`);
}

/** Column-aligned rows under a header. */
export function table(headers, rows) {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map(row => String(row[i] ?? '').length)),
  );
  const line = cells =>
    cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

  console.log(dim(`  ${line(headers)}`));
  for (const row of rows) console.log(`  ${line(row)}`);
}

/**
 * Closing lines, then PASS or FAIL on its own last line — every example ends
 * this way, and scripts depend on it.
 */
export function verdict(ok, ...lines) {
  console.log('');
  for (const line of lines) console.log(`  ${line}`);
  console.log(ok ? green('PASS') : red('FAIL'));
}
