// ─────────────────────────────────────────────────────────────────────────────
// PDC Dental – core processing logic (no DOM, no XLSX dependency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan up to the first 6 rows and return the index of the one that looks like
 * a header (contains at least 3 of the expected keywords).
 */
function detectHeaderRow(rows) {
  const kw = ['ชื่อ', 'opd', 'fee', 'date', 'treat', 'no', 'id'];
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const s = (rows[i] || []).join(' ').toLowerCase();
    if (kw.filter(k => s.includes(k)).length >= 3) return i;
  }
  return 0;
}

/**
 * Return the first column index whose lowercased header contains any candidate.
 * Returns -1 if none match.
 */
function colIdx(headers, candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h.includes(c.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Main processing function.
 *
 * @param {Object} yearSheets  – { "2562": [ [row], [row], … ], "2563": … }
 *                               Each value is the raw sheet as array-of-arrays
 *                               (header row included).
 * @returns {{ outputSheets: Array, patientCount: number }}
 *   outputSheets: [{ name: "มาXปี+YY", rows: [{name,opd,idYear,fee,date,treat,totalYears,prevYear}] }]
 */
function buildFromYearSheets(yearSheets) {
  const yearKeys = Object.keys(yearSheets).sort();

  // ── 1. Build patientMap  (key = OPD No. | patient name)
  const patientMap = {};

  yearKeys.forEach(yearStr => {
    const rows = yearSheets[yearStr];
    const hi   = detectHeaderRow(rows);
    const hdrs = (rows[hi] || []).map(h => String(h ?? '').trim().toLowerCase());

    const C = {
      name:   colIdx(hdrs, ['ชื่อลูกค้า', 'ชื่อ-นามสกุล', 'ชื่อ', 'name', 'customer']),
      opd:    colIdx(hdrs, ['opd no.', 'opd no', 'opd', 'opdno']),
      idYear: colIdx(hdrs, ['id-year', 'id year', 'idyear', 'id-ปี', 'id_year']),
      fee:    colIdx(hdrs, ['fee', 'ค่าบริการ', 'ราคา', 'amount']),
      date:   colIdx(hdrs, ['date', 'วันที่', 'วันที่รับ']),
      treat:  colIdx(hdrs, ['treat', 'treatment', 'การรักษา']),
    };

    for (let i = hi + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;

      const name   = C.name   >= 0 ? String(row[C.name]   ?? '').trim() : '';
      const opd    = C.opd    >= 0 ? String(row[C.opd]    ?? '').trim() : '';
      const idYear = C.idYear >= 0 ? String(row[C.idYear] ?? '').trim() : '';
      const fee    = C.fee    >= 0 ? row[C.fee]   : '';
      const date   = C.date   >= 0 ? row[C.date]  : '';
      const treat  = C.treat  >= 0 ? row[C.treat] : '';

      if (!name && !opd) continue;

      const key = opd || name;

      if (!patientMap[key]) patientMap[key] = { name, opd, years: {} };
      if (!patientMap[key].name && name) patientMap[key].name = name;
      if (!patientMap[key].opd  && opd)  patientMap[key].opd  = opd;

      // Last row wins for duplicate entries within the same year sheet
      patientMap[key].years[yearStr] = { idYear, fee, date, treat };
    }
  });

  // ── 2. Group by (totalYears, latestYear)
  const groups = {};

  Object.values(patientMap).forEach(p => {
    const visited   = Object.keys(p.years).sort();
    const total     = visited.length;
    const latest    = visited[visited.length - 1];
    const latestYY  = latest.slice(-2);
    const prevYear  = visited.length >= 2 ? visited[visited.length - 2].slice(-2) : '';

    const groupKey = `มา${total}ปี+${latestYY}`;
    if (!groups[groupKey]) groups[groupKey] = [];

    const d = p.years[latest];
    groups[groupKey].push({
      name: p.name,
      opd:  p.opd,
      idYear:     d.idYear,
      fee:        d.fee,
      date:       d.date,
      treat:      d.treat,
      totalYears: total,
      latestYY,
      prevYear,
    });
  });

  // ── 3. Sort groups: most years first; tie-break by latest year descending
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const ay = parseInt(a.match(/มา(\d+)ปี/)[1]);
    const by = parseInt(b.match(/มา(\d+)ปี/)[1]);
    if (ay !== by) return by - ay;
    const al = parseInt(a.match(/\+(\d+)/)[1]);
    const bl = parseInt(b.match(/\+(\d+)/)[1]);
    return bl - al;
  });

  // ── 4. Sort rows within each group alphabetically (OPD No. then name)
  const outputSheets = sortedKeys.map(key => ({
    name: key,
    rows: groups[key].sort((a, b) =>
      (a.opd || a.name || '').localeCompare(b.opd || b.name || '', 'th')
    ),
  }));

  return { outputSheets, patientCount: Object.keys(patientMap).length };
}

// Export for Node.js (used by test runner) and keep globals for browser
if (typeof module !== 'undefined') {
  module.exports = { detectHeaderRow, colIdx, buildFromYearSheets };
}
