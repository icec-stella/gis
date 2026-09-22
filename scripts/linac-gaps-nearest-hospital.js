/**
 * LINAC-gap Walmarts with their single NEAREST qualifying hospital (general acute or critical
 * access) and the OSRM drive time to it. Works for one state or the entire United States.
 *
 *   node scripts/linac-gaps-nearest-hospital.js                         # TX, 60 min (defaults)
 *   node scripts/linac-gaps-nearest-hospital.js --state TX --linac-minutes 75
 *   node scripts/linac-gaps-nearest-hospital.js --state US --linac-minutes 75   # nationwide
 *
 * Definitions (match the web app's methodology):
 *   - LINAC gap = a Walmart with no LINAC center reachable within --linac-minutes (default 60)
 *     by OSRM road routing across the connected (contiguous) network.
 *   - Nearest hospital = the closest eligible hospital (OPEN, general acute or critical access)
 *     by OSRM drive time. NO 30-min cutoff is applied here, so systemic gaps (nearest hospital
 *     > 30 min) still report their nearest hospital + drive time.
 *
 * Efficiency: for each gap we first take the HAVERSINE_CANDIDATES straight-line-nearest hospitals
 * (from the state's routable pool) and only OSRM-test those; the true road-nearest is always within
 * that shortlist, which keeps the nationwide run tractable.
 *
 * Writes scripts/output/<scope>-linac-gaps-nearest-hospital-<minutes>min.csv and prints a summary.
 *
 * Optional comparison to a prior run (e.g. mark rows that appeared in the 75-min export):
 *   node scripts/linac-gaps-nearest-hospital.js --state US --linac-minutes 60 \
 *     --compare-to scripts/output/us-linac-gaps-nearest-hospital-75min.csv
 */

const fs = require('fs');
const path = require('path');

const {
    getDriveTimes,
    loadDataFromFile,
    linacRowsForDriveTimeOsrm,
    walmartRowHasValidCoords,
    hospitalRowsForDriveTimeOsrm,
    HOSPITAL_BACKSTOP_MINUTES
} = require('../server.js');

const OUT_DIR = path.join(__dirname, 'output');
const HAVERSINE_CANDIDATES = 30;

function getArg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    return fallback;
}

function getLinacMinutes() {
    const v = parseFloat(getArg('--linac-minutes', '60'));
    return Number.isFinite(v) && v > 0 ? v : 60;
}

function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

function haversineKm(aLat, aLon, bLat, bLon) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

function nearestCandidates(walmart, dests, k) {
    const gLat = num(walmart.latitude);
    const gLon = num(walmart.longitude);
    if (gLat == null || gLon == null) return [];
    return dests
        .map((h) => ({ h, d: haversineKm(gLat, gLon, num(h.LATITUDE), num(h.LONGITUDE)) }))
        .filter((x) => Number.isFinite(x.d))
        .sort((a, b) => a.d - b.d)
        .slice(0, k)
        .map((x) => x.h);
}

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function writeCsv(filePath, headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) lines.push(row.map(csvEscape).join(','));
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function walmartKey(state, name, city, address) {
    return [state, name, city, address]
        .map((s) => String(s ?? '').trim().toLowerCase())
        .join('|');
}

function walmartKeyFromRow(w) {
    return walmartKey(w.state, w.name, w.city, w.street_address);
}

/** Parse a simple CSV (handles quoted fields) into row objects keyed by header. */
function parseCsv(text) {
    const rows = [];
    let i = 0;
    const len = text.length;

    function readField() {
        if (i >= len) return null;
        if (text[i] === '"') {
            i += 1;
            let field = '';
            while (i < len) {
                if (text[i] === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    field += text[i];
                    i += 1;
                }
            }
            if (text[i] === ',') i += 1;
            return field;
        }
        let field = '';
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
            field += text[i];
            i += 1;
        }
        if (text[i] === ',') i += 1;
        return field;
    }

    const headers = [];
    while (i < len && text[i] !== '\n' && text[i] !== '\r') {
        const h = readField();
        if (h != null) headers.push(h);
    }
    if (text[i] === '\r') i += 1;
    if (text[i] === '\n') i += 1;

    while (i < len) {
        const values = [];
        while (i < len && text[i] !== '\n' && text[i] !== '\r') {
            const v = readField();
            if (v != null) values.push(v);
        }
        if (text[i] === '\r') i += 1;
        if (text[i] === '\n') i += 1;
        if (values.length === 0) continue;
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = values[idx] ?? '';
        });
        rows.push(row);
    }
    return rows;
}

function loadCompareKeys(comparePath) {
    if (!comparePath || !fs.existsSync(comparePath)) return null;
    const rows = parseCsv(fs.readFileSync(comparePath, 'utf8'));
    const keys = new Set(
        rows.map((r) =>
            walmartKey(r.walmart_state, r.walmart_name, r.walmart_city, r.walmart_address)
        )
    );
    return { path: comparePath, keys, count: keys.size };
}

/** LINAC-gap Walmarts for a state (no LINAC within threshold seconds). */
async function linacGapsForState(stateAbbr, walmartLocations, linacLocations, thresholdSeconds) {
    const stateWalmarts = walmartLocations.filter((w) => w.state === stateAbbr);
    const withCoords = stateWalmarts.filter(walmartRowHasValidCoords);
    const validLinacs = linacRowsForDriveTimeOsrm(stateAbbr, linacLocations);

    let matrix = null;
    if (validLinacs.length > 0 && withCoords.length > 0) {
        matrix = await getDriveTimes(withCoords, validLinacs);
    }

    const gaps = [];
    let idx = 0;
    for (const w of stateWalmarts) {
        if (!walmartRowHasValidCoords(w)) {
            gaps.push({ walmart: w, noCoords: true });
            continue;
        }
        const row = matrix ? matrix[idx] : null;
        idx += 1;
        const within = Array.isArray(row) && row.some((s) => s != null && s <= thresholdSeconds);
        if (!within) gaps.push({ walmart: w, noCoords: false });
    }
    return gaps;
}

/** Nearest eligible hospital for a single gap, by OSRM drive time (no distance cutoff). */
async function nearestHospitalForGap(walmart, dests) {
    const candidates = nearestCandidates(walmart, dests, HAVERSINE_CANDIDATES);
    if (candidates.length === 0) return null;
    const matrix = await getDriveTimes([walmart], candidates);
    const row = matrix && matrix[0];
    if (!Array.isArray(row)) return null;
    let bestSec = Infinity;
    let bestIdx = -1;
    for (let j = 0; j < row.length; j++) {
        const s = row[j];
        if (s != null && s < bestSec) {
            bestSec = s;
            bestIdx = j;
        }
    }
    if (bestIdx < 0) return null;
    const h = candidates[bestIdx];
    return {
        name: String(h.NAME ?? '').trim(),
        city: String(h.CITY ?? '').trim(),
        state: String(h.STATE ?? '').trim(),
        type: String(h.TYPE ?? '').trim(),
        driveMinutes: bestSec / 60
    };
}

async function run() {
    const linacMinutes = getLinacMinutes();
    const thresholdSeconds = linacMinutes * 60;
    const stateArgRaw = String(getArg('--state', 'TX')).toUpperCase();
    const nationwide = stateArgRaw === 'US' || stateArgRaw === 'ALL';

    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const linacLocations = loadDataFromFile('./src/data/linac-locations.json');
    const hospitals = loadDataFromFile('./src/data/hospital-locations.json');

    const codes = nationwide
        ? [...new Set(walmartLocations.map((w) => w.state).filter(Boolean))].sort()
        : [stateArgRaw];

    console.log(
        `Scope: ${nationwide ? 'United States' : stateArgRaw} | LINAC threshold: ${linacMinutes} min | ` +
        `${codes.length} state(s)`
    );

    const results = [];
    let processed = 0;

    for (const stateAbbr of codes) {
        const gaps = await linacGapsForState(stateAbbr, walmartLocations, linacLocations, thresholdSeconds);
        const dests = hospitalRowsForDriveTimeOsrm(stateAbbr, hospitals);

        for (const g of gaps) {
            if (g.noCoords) {
                results.push({ walmart: g.walmart, nearest: null, note: 'No valid coordinates' });
                continue;
            }
            const nearest = await nearestHospitalForGap(g.walmart, dests);
            results.push({ walmart: g.walmart, nearest, note: nearest ? '' : 'No route to a hospital' });
        }

        processed += 1;
        process.stdout.write(
            `\r[${processed}/${codes.length}] ${stateAbbr} — ${gaps.length} gap(s); running total ${results.length}   `
        );
    }
    process.stdout.write('\n');

    // Most isolated first (longest drive to nearest hospital); no-result rows last.
    results.sort((a, b) => {
        const da = a.nearest ? a.nearest.driveMinutes : Infinity;
        const db = b.nearest ? b.nearest.driveMinutes : Infinity;
        return db - da;
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const scopeLabel = nationwide ? 'us' : stateArgRaw.toLowerCase();
    const csvPath = path.join(OUT_DIR, `${scopeLabel}-linac-gaps-nearest-hospital-${linacMinutes}min.csv`);

    const compareArg = getArg('--compare-to', '');
    const defaultComparePath = path.join(
        OUT_DIR,
        `${scopeLabel}-linac-gaps-nearest-hospital-75min.csv`
    );
    const comparePath = compareArg || (linacMinutes !== 75 ? defaultComparePath : '');
    const compare = loadCompareKeys(comparePath);
    const compareLabel = compare
        ? path.basename(compare.path).replace(/\.csv$/i, '')
        : null;

    const headers = [
        'walmart_state',
        'walmart_name',
        'walmart_city',
        'walmart_address',
        'nearest_hospital',
        'hospital_city',
        'hospital_state',
        'hospital_type',
        'drive_minutes',
        'classification'
    ];
    if (compare) headers.push('in_75min_run');

    writeCsv(
        csvPath,
        headers,
        results.map((r) => {
            const w = r.walmart;
            const n = r.nearest;
            const within = n && n.driveMinutes <= HOSPITAL_BACKSTOP_MINUTES;
            const row = [
                w.state,
                w.name,
                w.city,
                w.street_address,
                n ? n.name : r.note,
                n ? n.city : '',
                n ? n.state : '',
                n ? n.type : '',
                n ? n.driveMinutes.toFixed(1) : '',
                n ? (within ? 'viable (<= 30 min)' : 'systemic (> 30 min)') : 'unknown'
            ];
            if (compare) {
                row.push(compare.keys.has(walmartKeyFromRow(w)) ? 'yes' : 'no');
            }
            return row;
        })
    );

    const withHosp = results.filter((r) => r.nearest);
    const systemic = withHosp.filter((r) => r.nearest.driveMinutes > HOSPITAL_BACKSTOP_MINUTES);
    console.log(
        `\nTotals: ${results.length} LINAC gaps | ${withHosp.length} with a nearest hospital | ` +
        `${systemic.length} systemic (> ${HOSPITAL_BACKSTOP_MINUTES} min) | ` +
        `${results.length - withHosp.length} without coords/route`
    );

    if (compare) {
        const inPrior = results.filter((r) => compare.keys.has(walmartKeyFromRow(r.walmart))).length;
        const newAtThreshold = results.length - inPrior;
        console.log(
            `\nCompared to ${compareLabel}: ${inPrior}/${compare.count} prior gaps present | ` +
            `${newAtThreshold} new at ${linacMinutes} min (not in 75-min run)`
        );
    }

    if (systemic.length > 0) {
        console.log('\nSystemic gaps (nearest hospital > 30 min):');
        for (const r of systemic) {
            const w = r.walmart;
            const n = r.nearest;
            console.log(
                `  ${n.driveMinutes.toFixed(1).padStart(5)} min  |  ${w.name} (${w.city}, ${w.state}) ` +
                `\u2192 ${n.name} — ${n.city}, ${n.state}`
            );
        }
    }

    console.log(`\nWrote ${csvPath}`);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
