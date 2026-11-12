function cell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Excel treats a leading =, +, - or @ as a formula. Prefixing with a single
  // quote is the least surprising way to keep the text exactly as it is.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(headers, rows) {
  const lines = [headers.map(cell).join(',')];
  rows.forEach(row => lines.push(row.map(cell).join(',')));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildCsv, cell };
