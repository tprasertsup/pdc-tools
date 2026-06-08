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
 * Trim leading/trailing whitespace and collapse any run of internal whitespace
 * to a single space.  ' ธนนันท์    ประเสริฐทรัพย์' → 'ธนนันท์ ประเสริฐทรัพย์'
 */
function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
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

      const name   = C.name   >= 0 ? normalizeName(row[C.name]) : '';
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

// ─────────────────────────────────────────────────────────────────────────────
// Patient follow-up summary – doctor-sheet input processing (no DOM/XLSX)
// ─────────────────────────────────────────────────────────────────────────────

function normalizePatientKey(raw) {
  return normalizeName(raw).toLocaleLowerCase('th-TH');
}

function parseNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const cleaned = String(raw).replace(/,/g, '').trim();
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseVisitYear(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  const m = String(raw).trim().match(/(25\d{2}|20\d{2}|\d{2})/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n < 100) return 2500 + n;
  return n;
}

function formatYearRange(years) {
  if (!years || years.length === 0) return '';
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  return `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

function getConsecutiveRuns(years) {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const runs = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) {
      current.push(sorted[i]);
    } else {
      runs.push(current);
      current = [sorted[i]];
    }
  }
  runs.push(current);
  return runs;
}

function getCurrentConsecutiveYears(years, latestYear) {
  const set = new Set(years);
  let count = 0;
  let y = latestYear;
  while (set.has(y)) {
    count++;
    y--;
  }
  return count;
}

function getMaxConsecutiveRun(years) {
  const runs = getConsecutiveRuns(years);
  if (runs.length === 0) return [];
  return runs.reduce((best, run) => {
    if (run.length !== best.length) return run.length > best.length ? run : best;
    return run[run.length - 1] > best[best.length - 1] ? run : best;
  }, runs[0]);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(v => String(v).trim()))]
    .sort((a, b) => a.localeCompare(b, 'th'));
}

function chooseMostFrequent(values) {
  const counts = new Map();
  values.filter(Boolean).forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'th'))[0]?.[0] || '';
}

function classifyPatientStatus(firstYear, latestYear, datasetLatestYear) {
  if (latestYear === datasetLatestYear && firstYear === latestYear) return 'New';
  if (latestYear === datasetLatestYear) return 'Active';
  if (latestYear === datasetLatestYear - 1) return 'At Risk';
  return 'Lost';
}

function classifyReturnPattern(years, datasetLatestYear) {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const latest = sorted[sorted.length - 1];
  const currentStreak = getCurrentConsecutiveYears(sorted, latest);
  const previous = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

  if (sorted.length === 1 && latest === datasetLatestYear) return 'New';
  if (sorted.length === 1) return 'One-time';
  if (latest < datasetLatestYear - 1) return 'Lapsed';
  if (latest === datasetLatestYear - 1) return 'At Risk';
  if (previous !== null && latest - previous > 1) return 'Returning';
  if (currentStreak >= 3) return 'Consistent';
  return 'Recent Active';
}

function isZeroFeeDataFlag(flag) {
  const normalized = String(flag || '').toLowerCase();
  return normalized.includes('fee = 0') ||
    normalized.includes('zero-fee') ||
    normalized.includes('zero fee') ||
    normalized.includes('0 fee');
}

function getDataRecheckFlags(dataFlags) {
  return String(dataFlags || '')
    .split(',')
    .map(flag => flag.trim())
    .filter(Boolean)
    .filter(flag => !isZeroFeeDataFlag(flag));
}

function getThaiPriority(summary, datasetLatestYear) {
  const inactiveGap = datasetLatestYear - summary.latestYear;
  const highValue = summary.lifetimeFee >= 50000 || summary.latestYearFee >= 15000;
  const loyal = summary.maxConsecutiveYears >= 3 || summary.activeYearCount >= 3;
  const dataRecheckFlags = getDataRecheckFlags(summary.dataFlags);

  if (dataRecheckFlags.length) return { priority: 'สูง', reason: `ควรตรวจสอบข้อมูลก่อนติดตาม: ${dataRecheckFlags.join(', ')}` };
  if (summary.status === 'Lost' && highValue) return { priority: 'สูง', reason: 'คนไข้มูลค่าสูงไม่ได้กลับมาหลายปี ควรติดตาม' };
  if (summary.status === 'At Risk' && (highValue || loyal)) return { priority: 'สูง', reason: 'คนไข้ประจำหรือมูลค่าสูงไม่มาในปีล่าสุด ควรติดตาม' };
  if (summary.returnPattern === 'Returning') return { priority: 'กลาง', reason: 'คนไข้กลับมาหลังเว้นช่วง ควรรักษาความสัมพันธ์' };
  if (summary.status === 'Active' && summary.feeChange < 0) return { priority: 'กลาง', reason: 'ยังมาในปีล่าสุด แต่ยอดใช้บริการลดลงจากครั้งก่อน' };
  if (summary.status === 'New') return { priority: 'กลาง', reason: 'คนไข้ใหม่ ควรดูแลให้กลับมาต่อเนื่อง' };
  if (inactiveGap > 0) return { priority: 'กลาง', reason: 'ไม่ได้มาในปีล่าสุด อาจพิจารณาติดตาม' };
  return { priority: 'ต่ำ', reason: 'ยังมาใช้บริการตามปกติ' };
}


function doctorYearColIdx(headers) {
  const exact = headers.findIndex(h => ['year', 'last year', 'ปี', 'ปีที่มา'].includes(h.trim().toLowerCase()));
  if (exact >= 0) return exact;
  const lastYear = headers.findIndex(h => h.includes('last year'));
  if (lastYear >= 0) return lastYear;
  return headers.findIndex(h => (h.includes('year') || h.includes('ปี')) && !h.includes('id'));
}

function buildFromDoctorSheets(doctorSheets) {
  const rawRows = [];
  const dataIssues = [];

  Object.entries(doctorSheets).forEach(([doctorNameRaw, rows]) => {
    const doctorName = normalizeName(doctorNameRaw) || 'ไม่ทราบชื่อหมอ';
    const hi = detectHeaderRow(rows);
    const hdrs = (rows[hi] || []).map(h => String(h ?? '').trim().toLowerCase());
    const C = {
      no: colIdx(hdrs, ['no', 'ลำดับ']),
      name: colIdx(hdrs, ['ชื่อลูกค้า', 'ชื่อ-นามสกุล', 'ชื่อ', 'name', 'customer']),
      opd: colIdx(hdrs, ['opd no.', 'opd no', 'opd', 'opdno']),
      fee: colIdx(hdrs, ['fee', 'ค่าบริการ', 'ราคา', 'amount']),
      year: doctorYearColIdx(hdrs),
    };

    if (C.name < 0 || C.year < 0) {
      dataIssues.push({ issueType: 'Missing Required Column', sheet: doctorName, row: hi + 1, patientName: '', opd: '', detail: 'ต้องมีคอลัมน์ชื่อคนไข้ และ Last Year/Year' });
      return;
    }

    for (let i = hi + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;

      const patientName = C.name >= 0 ? normalizeName(row[C.name]) : '';
      const opd = C.opd >= 0 ? String(row[C.opd] ?? '').trim() : '';
      const feeRaw = C.fee >= 0 ? row[C.fee] : '';
      const fee = parseNumber(feeRaw);
      const yearRaw = C.year >= 0 ? row[C.year] : '';
      const year = parseVisitYear(yearRaw);
      const sourceNo = C.no >= 0 ? row[C.no] : '';

      if (!patientName) {
        dataIssues.push({ issueType: 'Missing Patient Name', sheet: doctorName, row: i + 1, patientName: '', opd, detail: 'ข้าม row นี้เพราะไม่มีชื่อคนไข้' });
        continue;
      }
      if (!year) {
        dataIssues.push({ issueType: 'Invalid Year', sheet: doctorName, row: i + 1, patientName, opd, detail: `Year/Last Year ไม่ถูกต้อง: ${yearRaw}` });
        continue;
      }
      if (C.fee >= 0 && feeRaw !== '' && Number.isNaN(Number(String(feeRaw).replace(/,/g, '').trim()))) {
        dataIssues.push({ issueType: 'Invalid Fee', sheet: doctorName, row: i + 1, patientName, opd, detail: `Fee แปลงเป็นตัวเลขไม่ได้: ${feeRaw}` });
      }

      rawRows.push({
        sourceSheet: doctorName,
        sourceRow: i + 1,
        sourceNo,
        patientName,
        patientKey: normalizePatientKey(patientName),
        opd,
        fee,
        year,
        doctor: doctorName,
      });
    }
  });

  const patientMap = new Map();
  rawRows.forEach(r => {
    if (!patientMap.has(r.patientKey)) patientMap.set(r.patientKey, []);
    patientMap.get(r.patientKey).push(r);
  });

  const opdToNames = new Map();
  rawRows.forEach(r => {
    if (!r.opd) return;
    if (!opdToNames.has(r.opd)) opdToNames.set(r.opd, new Set());
    opdToNames.get(r.opd).add(r.patientName);
  });
  opdToNames.forEach((names, opd) => {
    if (names.size > 1) {
      dataIssues.push({ issueType: 'Multiple Names for Same OPD', sheet: '', row: '', patientName: [...names].join(', '), opd, detail: 'OPD เดียวกันพบหลายชื่อ ควรตรวจสอบ' });
    }
  });

  const datasetYears = [...new Set(rawRows.map(r => r.year))].sort((a, b) => a - b);
  const datasetLatestYear = datasetYears[datasetYears.length - 1] || null;
  const patientSummaries = [];
  const yearlyDetails = [];
  const doctorRelationships = [];

  patientMap.forEach(rows => {
    const patientName = chooseMostFrequent(rows.map(r => r.patientName));
    const opdList = uniqueSorted(rows.map(r => r.opd));
    const years = [...new Set(rows.map(r => r.year))].sort((a, b) => a - b);
    const firstYear = years[0];
    const latestYear = years[years.length - 1];
    const previousYear = years.length >= 2 ? years[years.length - 2] : '';
    const latestRows = rows.filter(r => r.year === latestYear);
    const previousRows = previousYear ? rows.filter(r => r.year === previousYear) : [];
    const latestYearFee = latestRows.reduce((sum, r) => sum + r.fee, 0);
    const previousYearFee = previousRows.reduce((sum, r) => sum + r.fee, 0);
    const lifetimeFee = rows.reduce((sum, r) => sum + r.fee, 0);
    const maxRun = getMaxConsecutiveRun(years);
    const dataFlags = [];
    if (opdList.length > 1) dataFlags.push('พบ OPD หลายเลขในชื่อเดียวกัน');
    if (rows.some(r => r.fee === 0)) dataFlags.push('มี visit ค่า Fee = 0');

    years.forEach(year => {
      const yearRows = rows.filter(r => r.year === year);
      const yearFee = yearRows.reduce((sum, r) => sum + r.fee, 0);
      yearlyDetails.push({
        patientName,
        opd: opdList[0] || '',
        year,
        fee: yearFee,
        visitCount: yearRows.length,
        doctors: uniqueSorted(yearRows.map(r => r.doctor)).join(', '),
        doctorCount: uniqueSorted(yearRows.map(r => r.doctor)).length,
        avgFeePerVisit: yearRows.length ? Math.round(yearFee / yearRows.length) : 0,
        zeroFeeVisits: yearRows.filter(r => r.fee === 0).length,
        isLatestYear: year === latestYear ? 'Yes' : 'No',
      });
    });

    const doctorStats = new Map();
    rows.forEach(r => {
      if (!doctorStats.has(r.doctor)) doctorStats.set(r.doctor, { doctor: r.doctor, years: new Set(), visits: 0, fee: 0 });
      const s = doctorStats.get(r.doctor);
      s.years.add(r.year);
      s.visits++;
      s.fee += r.fee;
    });

    const doctorRows = [...doctorStats.values()].map(s => {
      const dy = [...s.years].sort((a, b) => a - b);
      const maxDoctorRun = getMaxConsecutiveRun(dy);
      const currentDoctorStreak = dy.includes(latestYear) ? getCurrentConsecutiveYears(dy, latestYear) : 0;
      const relationship = {
        patientName,
        opd: opdList[0] || '',
        doctor: s.doctor,
        firstYearWithDoctor: dy[0],
        latestYearWithDoctor: dy[dy.length - 1],
        yearCountWithDoctor: dy.length,
        consecutiveYearsWithDoctorToLatest: currentDoctorStreak,
        maxConsecutiveYearsWithDoctor: maxDoctorRun.length,
        visitCountWithDoctor: s.visits,
        feeWithDoctor: s.fee,
        isSeenInLatestPatientYear: dy.includes(latestYear) ? 'Yes' : 'No',
        doctorRole: '',
      };
      doctorRelationships.push(relationship);
      return relationship;
    });

    const longestDoctor = [...doctorRows].sort((a, b) =>
      b.yearCountWithDoctor - a.yearCountWithDoctor ||
      (b.isSeenInLatestPatientYear === 'Yes') - (a.isSeenInLatestPatientYear === 'Yes') ||
      b.feeWithDoctor - a.feeWithDoctor ||
      a.doctor.localeCompare(b.doctor, 'th')
    )[0];
    const mainDoctorLatest = chooseMostFrequent(latestRows.map(r => r.doctor));
    const mainDoctorLifetime = [...doctorRows].sort((a, b) => b.feeWithDoctor - a.feeWithDoctor || b.visitCountWithDoctor - a.visitCountWithDoctor)[0]?.doctor || '';

    doctorRelationships.forEach(rel => {
      if (rel.patientName === patientName && rel.opd === (opdList[0] || '')) {
        rel.doctorRole = rel.doctor === mainDoctorLifetime ? 'Main' : 'Secondary';
      }
    });

    const summary = {
      patientName,
      opd: opdList[0] || '',
      allOpdNos: opdList.join(', '),
      dataFlags: dataFlags.join(', '),
      status: classifyPatientStatus(firstYear, latestYear, datasetLatestYear),
      firstYear,
      latestYear,
      previousYear,
      visitedYears: years.join(', '),
      currentConsecutiveYears: getCurrentConsecutiveYears(years, latestYear),
      maxConsecutiveYears: maxRun.length,
      latestYearFee,
      latestYearVisitCount: latestRows.length,
      latestYearDoctors: uniqueSorted(latestRows.map(r => r.doctor)).join(', '),
      previousYearFee,
      previousYearVisitCount: previousRows.length,
      previousYearDoctors: uniqueSorted(previousRows.map(r => r.doctor)).join(', '),
      feeChange: latestYearFee - previousYearFee,
      lifetimeFee,
      lifetimeVisitCount: rows.length,
      activeYearCount: years.length,
      longestRelationshipDoctor: longestDoctor?.doctor || '',
      longestRelationshipYearsCount: longestDoctor?.yearCountWithDoctor || 0,
      longestRelationshipYearRange: longestDoctor ? formatYearRange([longestDoctor.firstYearWithDoctor, longestDoctor.latestYearWithDoctor]) : '',
      mainDoctorLatestYear: mainDoctorLatest,
      mainDoctorLifetime,
      doctorLoyaltyType: doctorRows.length <= 1 ? 'Single Doctor' : 'Multi Doctor',
      returnPattern: classifyReturnPattern(years, datasetLatestYear),
    };
    const priority = getThaiPriority(summary, datasetLatestYear);
    summary.followUpPriority = priority.priority;
    summary.followUpReason = priority.reason;
    patientSummaries.push(summary);

    if (opdList.length > 1) {
      dataIssues.push({ issueType: 'Multiple OPD for Same Name', sheet: '', row: '', patientName, opd: opdList.join(', '), detail: 'ชื่อเดียวกันพบ OPD หลายเลข ควรตรวจสอบ' });
    }
  });

  patientSummaries.sort((a, b) =>
    b.latestYear - a.latestYear ||
    ({ 'สูง': 3, 'กลาง': 2, 'ต่ำ': 1 }[b.followUpPriority] || 0) - ({ 'สูง': 3, 'กลาง': 2, 'ต่ำ': 1 }[a.followUpPriority] || 0) ||
    b.latestYearFee - a.latestYearFee ||
    a.patientName.localeCompare(b.patientName, 'th')
  );
  yearlyDetails.sort((a, b) => a.patientName.localeCompare(b.patientName, 'th') || b.year - a.year);
  doctorRelationships.sort((a, b) => a.patientName.localeCompare(b.patientName, 'th') || b.yearCountWithDoctor - a.yearCountWithDoctor || a.doctor.localeCompare(b.doctor, 'th'));

  return {
    patientSummaries,
    yearlyDetails,
    doctorRelationships,
    dataIssues,
    rawRows,
    patientCount: patientSummaries.length,
    visitCount: rawRows.length,
    datasetYears,
    datasetLatestYear,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    detectHeaderRow,
    colIdx,
    normalizeName,
    buildFromYearSheets,
    normalizePatientKey,
    parseNumber,
    parseVisitYear,
    doctorYearColIdx,
    getCurrentConsecutiveYears,
    getMaxConsecutiveRun,
    buildFromDoctorSheets,
  };
}
