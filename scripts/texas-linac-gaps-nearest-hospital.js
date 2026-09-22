/**
 * Texas LINAC-gap Walmarts with their single NEAREST qualifying hospital (general acute or
 * critical access) and the OSRM drive time to it.
 *
 *   node scripts/texas-linac-gaps-nearest-hospital.js
 *   node scripts/texas-linac-gaps-nearest-hospital.js --linac-minutes 45
 *
 * Definitions (match the web app's methodology):
 *   - LINAC gap = a TX Walmart with no LINAC center reachable within --linac-minutes (default 60)
 *     by OSRM road routing across the connected (contiguous) network.
 *   - Nearest hospital = the closest eligible hospital (OPEN, general acute or critical access)
 *     by OSRM drive time. Unlike the viable/systemic split, NO 30-min cutoff is applied here, so
 *     systemic gaps (nearest hospital > 30 min) still report their nearest hospital + drive time.
 *
 * Destination hospitals are restricted to Texas + bordering states (NM, OK, AR, LA); the nearest
 * hospital to any TX store is always within this set, which keeps the OSRM matrix tractable.
 *
 * Writes scripts/output/texas-linac-gaps-nearest-hospital.csv (+ a .txt summary) and prints a table.
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

const STATE = 'TX';
const NEIGHBOR_STATES = new Set(['TX', 'NM', 'OK', 'AR', 'LA']);
const OUT_DIR = path.join(__dirname, 'output');

function getLinacMinutesArg() {
    const i = process.argv.indexOf('--linac-minutes');
    if (i !== -1 && process.argv[i + 1]) {
        const v = parseFloat(process.argv[i + 1]);
        if (Number.isFinite(v) && v > 0) return v;
    }
    return 60;
}

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function writeCsv(filePath, headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) {
        lines.push(row.map(csvEscape).join(','));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function nearestHospitalFromRow(row, dests) {
    if (!Array.isArray(row) || dests.length === 0) return null;
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
    const h = dests[bestIdx];
    return {
        name: String(h.NAME ?? '').trim(),
        city: String(h.CITY ?? '').trim(),
        state: String(h.STATE ?? '').trim(),
        type: String(h.TYPE ?? '').trim(),
        driveMinutes: bestSec / 60
    };
}

async function run() {
    const linacMinutes = getLinacMinutesArg();
    const linacThresholdSeconds = linacMinutes * 60;

    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const linacLocations = loadDataFromFile('./src/data/linac-locations.json');
    const hospitals = loadDataFromFile('./src/data/hospital-locations.json');

    const stateWalmarts = walmartLocations.filter((w) => w.state === STATE);
    const withCoords = stateWalmarts.filter(walmartRowHasValidCoords);
    const validLinacs = linacRowsForDriveTimeOsrm(STATE, linacLocations);

    console.log(
        `[TX] ${stateWalmarts.length} Walmarts (${withCoords.length} with coords), ` +
        `${validLinacs.length} routable LINAC anchors, LINAC threshold ${linacMinutes} min.`
    );

    // Step 1 — which TX Walmarts are LINAC gaps (no LINAC within threshold).
    let linacMatrix = null;
    if (validLinacs.length > 0 && withCoords.length > 0) {
        console.log('[TX] OSRM: Walmarts \u2192 LINAC centers \u2026');
        linacMatrix = await getDriveTimes(withCoords, validLinacs);
    }

    const gaps = [];
    let coordIdx = 0;
    for (const w of stateWalmarts) {
        if (!walmartRowHasValidCoords(w)) {
            gaps.push({ walmart: w, noCoords: true });
            continue;
        }
        const row = linacMatrix ? linacMatrix[coordIdx] : null;
        coordIdx += 1;
        const withinRange =
            Array.isArray(row) && row.some((s) => s != null && s <= linacThresholdSeconds);
        if (!withinRange) gaps.push({ walmart: w, noCoords: false });
    }

    console.log(`[TX] ${gaps.length} LINAC-gap Walmarts (no LINAC within ${linacMinutes} min).`);

    // Step 2 — nearest qualifying hospital for each gap (no distance cutoff).
    const coordGaps = gaps.filter((g) => !g.noCoords).map((g) => g.walmart);
    const dests = hospitalRowsForDriveTimeOsrm(STATE, hospitals).filter((h) =>
        NEIGHBOR_STATES.has(h.STATE)
    );

    console.log(`[TX] OSRM: ${coordGaps.length} gaps \u2192 ${dests.length} hospitals (TX + neighbors) \u2026`);
    let hospMatrix = null;
    if (coordGaps.length > 0 && dests.length > 0) {
        hospMatrix = await getDriveTimes(coordGaps, dests);
    }

    const results = [];
    let gi = 0;
    for (const g of gaps) {
        if (g.noCoords) {
            results.push({
                walmart: g.walmart,
                nearest: null,
                note: 'No valid coordinates for this Walmart'
            });
            continue;
        }
        const nearest = nearestHospitalFromRow(hospMatrix ? hospMatrix[gi] : null, dests);
        gi += 1;
        results.push({ walmart: g.walmart, nearest, note: '' });
    }

    // Most isolated first (longest drive to nearest hospital); no-result rows last.
    results.sort((a, b) => {
        const da = a.nearest ? a.nearest.driveMinutes : Infinity;
        const db = b.nearest ? b.nearest.driveMinutes : Infinity;
        return db - da;
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const csvPath = path.join(OUT_DIR, 'texas-linac-gaps-nearest-hospital.csv');
    writeCsv(
        csvPath,
        [
            'walmart_name',
            'walmart_city',
            'walmart_address',
            'nearest_hospital',
            'hospital_city',
            'hospital_state',
            'hospital_type',
            'drive_minutes',
            'classification'
        ],
        results.map((r) => {
            const w = r.walmart;
            const n = r.nearest;
            const within = n && n.driveMinutes <= HOSPITAL_BACKSTOP_MINUTES;
            return [
                w.name,
                w.city,
                w.street_address,
                n ? n.name : r.note,
                n ? n.city : '',
                n ? n.state : '',
                n ? n.type : '',
                n ? n.driveMinutes.toFixed(1) : '',
                n ? (within ? 'viable (\u2264 30 min)' : 'systemic (> 30 min)') : 'unknown'
            ];
        })
    );

    // Console table.
    console.log('\nTexas LINAC gaps \u2014 nearest qualifying hospital (OSRM drive time):\n');
    for (const r of results) {
        const w = r.walmart;
        if (!r.nearest) {
            console.log(`  ${w.name} (${w.city}) \u2014 ${r.note}`);
            continue;
        }
        const n = r.nearest;
        console.log(
            `  ${n.driveMinutes.toFixed(1).padStart(5)} min  |  ${w.name} (${w.city}) ` +
            `\u2192 ${n.name} \u2014 ${n.city}, ${n.state}`
        );
    }

    const withHosp = results.filter((r) => r.nearest);
    const systemic = withHosp.filter((r) => r.nearest.driveMinutes > HOSPITAL_BACKSTOP_MINUTES);
    console.log(
        `\nTotals: ${gaps.length} LINAC gaps | ${withHosp.length} with a nearest hospital | ` +
        `${systemic.length} systemic (> ${HOSPITAL_BACKSTOP_MINUTES} min) | ` +
        `${gaps.length - withHosp.length} without coords/route`
    );
    console.log(`\nWrote ${csvPath}`);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
