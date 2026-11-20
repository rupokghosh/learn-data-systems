// Row versus column layouts on a toy disk, and column compression. Pure logic.

/**
 * Lay a table out on fixed-size pages, row by row or column by column.
 * columns: [{ name, bytes }], rows: number of rows.
 * Returns pages: [{ cells: [{ col, row }] }] where each cell is one byte.
 * In the column layout every column file starts on a fresh page.
 */
export function layout(columns, rows, pageSize, mode) {
  const pages = [];
  let cur = null;
  const push = (col, row) => {
    if (!cur || cur.cells.length >= pageSize) { cur = { cells: [], file: mode === "column" ? columns[col].name : "table" }; pages.push(cur); }
    cur.cells.push({ col, row });
  };
  if (mode === "row") {
    for (let r = 0; r < rows; r++) columns.forEach((c, ci) => { for (let b = 0; b < c.bytes; b++) push(ci, r); });
  } else {
    columns.forEach((c, ci) => {
      cur = null; // new file, new page
      for (let r = 0; r < rows; r++) for (let b = 0; b < c.bytes; b++) push(ci, r);
    });
  }
  return pages;
}

/**
 * Which pages a query must read, and which bytes in them it needs.
 * query: { filterCols: [col], filterRows: Set(row) | null (all), useCols: [col], pointRow?: row }
 * Row layout: a filter over all rows reads every page (no index). A point query reads the pages of that row.
 * Column layout: read whole filter columns; for the other needed columns read only
 * the pages that hold a matching row.
 */
export function pagesForQuery(pages, mode, q) {
  const read = new Set();
  const need = (cell) => {
    if (q.pointRow !== undefined) return cell.row === q.pointRow;
    if (q.filterCols.includes(cell.col)) return true;
    return q.useCols.includes(cell.col) && q.matches.has(cell.row);
  };
  pages.forEach((p, i) => {
    if (mode === "row") {
      if (q.pointRow !== undefined) { if (p.cells.some((c) => c.row === q.pointRow)) read.add(i); }
      else read.add(i);
    } else if (p.cells.some(need)) read.add(i);
  });
  let needed = 0;
  for (const i of read) for (const c of pages[i].cells) if (need(c)) needed++;
  return { read, need, needed };
}

/** One bitmap per distinct value: bit i is 1 when row i has that value. */
export function bitmaps(values) {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  return distinct.map((v) => ({ value: v, bits: values.map((x) => (x === v ? 1 : 0)) }));
}

/** Run-length encode a bitmap as alternating run lengths, starting with zeros. */
export function runLengths(bits) {
  const runs = [];
  let cur = 0, n = 0;
  for (const b of bits) {
    if (b === cur) n++;
    else { runs.push(n); cur = b; n = 1; }
  }
  runs.push(n);
  // Trailing zeros carry no information: drop them.
  if (cur === 0 && runs.length > 1) runs.pop();
  return runs;
}

export function decodeRuns(runs, length) {
  const bits = [];
  runs.forEach((n, i) => { for (let j = 0; j < n; j++) bits.push(i % 2); });
  while (bits.length < length) bits.push(0);
  return bits;
}

/** Sizes in bytes: raw column, plain bitmaps, run-length encoded bitmaps (one byte per run). */
export function encodedSizes(values, bytesPerValue = 4) {
  const maps = bitmaps(values);
  const raw = values.length * bytesPerValue;
  const bitmapBytes = maps.length * Math.ceil(values.length / 8);
  const rleBytes = maps.reduce((a, m) => a + runLengths(m.bits).length, 0);
  return { raw, bitmap: bitmapBytes, rle: rleBytes, distinct: maps.length };
}
