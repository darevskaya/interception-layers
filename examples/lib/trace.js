const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = code => text => (COLOUR ? `\x1b[${code}m${text}\x1b[0m` : String(text));

const dim = paint('2');
const cyan = paint('36');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');

const LABEL_WIDTH = 22;

function compact(value, max = 68) {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const MARKERS = {
  out: () => cyan('→'),
  in: () => dim('←'),
  event: () => yellow('⚡'),
};

export const trace = {
  step(label, detail = '') {
    console.log(`  ${cyan('▶')} ${label.padEnd(LABEL_WIDTH)} ${detail}`);
  },

  note(text) {
    console.log(dim(`    · ${text}`));
  },

  wire(direction, label, detail) {
    console.log(`  ${MARKERS[direction]()} ${label.padEnd(LABEL_WIDTH)} ${dim(compact(detail))}`);
  },

  bar(label, value, max, unit = 'ms', width = 32) {
    const filled = Math.max(1, Math.round((value / max) * width));
    console.log(`  ${label.padEnd(14)} ${'█'.repeat(filled).padEnd(width)} ${value} ${unit}`);
  },

  table(headers, rows) {
    const widths = headers.map((header, i) =>
      Math.max(header.length, ...rows.map(row => String(row[i] ?? '').length)),
    );
    const line = cells =>
      cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

    console.log(dim(`  ${line(headers)}`));
    for (const row of rows) console.log(`  ${line(row)}`);
  },

  verdict(ok, ...lines) {
    console.log('');
    for (const line of lines) console.log(`  ${line}`);
    console.log(ok ? green('PASS') : red('FAIL'));
  },
};
