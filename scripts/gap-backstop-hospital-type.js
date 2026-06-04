/**
 * Viable LINAC-gap Walmarts (60 min LINAC, 30 min hospital OSRM): nearest backstop TYPE
 * (general acute vs critical access). Writes state table + full store list.
 *
 *   node scripts/gap-backstop-hospital-type.js
 *   node scripts/gap-backstop-hospital-type.js --from-json   # regenerate CSV/MD only
 *
 * OSRM Table cache: in-memory per Node process (7-day TTL). Re-run uses cache only if the
 * same process is still alive; a new `node` invocation starts cold (server.js has its own cache).
 */

const fs = require('fs');
const path = require('path');

const {
    getDriveTimes,
    loadDataFromFile,
    linacRowsForDriveTimeOsrm,
    walmartRowHasValidCoords,
    hospitalRowsForDriveTimeOsrm,
    HOSPITAL_BACKSTOP_THRESHOLD_SECONDS
} = require('../server.js');

const OUT_DIR = path.join(__dirname, 'output');
const JSON_PATH = path.join(OUT_DIR, 'gap-backstop-analysis.json');
const LINAC_THRESHOLD_SECONDS = 60 * 60;

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

function writeMarkdownStateTable(filePath, stateRows, totals) {
    const lines = [
        '# Viable LINAC-gap backstop by state',
        '',
        '60 min LINAC threshold · 30 min hospital backstop · nearest hospital within 30 min',
        '',
        '| State | General acute | Critical access | Viable total | Systemic | LINAC gaps |',
        '|-------|--------------:|----------------:|-------------:|---------:|-----------:|'
    ];
    for (const r of stateRows) {
        if (r.viable === 0 && r.linacGap === 0) continue;
        lines.push(
            `| ${r.state} | ${r.generalAcute} | ${r.criticalAccess} | ${r.viable} | ${r.systemic} | ${r.linacGap} |`
        );
    }
    lines.push(
        `| **US total** | **${totals.generalAcute}** | **${totals.criticalAccess}** | **${totals.viable}** | **${totals.systemic}** | **${totals.linacGap}** |`,
        ''
    );
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function writeReports(payload) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2), 'utf8');

    const stateRows = payload.byState.filter((r) => r.linacGap > 0 || r.viable > 0);
    writeCsv(
        path.join(OUT_DIR, 'gap-backstop-by-state.csv'),
        ['state', 'general_acute', 'critical_access', 'viable_total', 'systemic', 'linac_gaps'],
        stateRows.map((r) => [
            r.state,
            r.generalAcute,
            r.criticalAccess,
            r.viable,
            r.systemic,
            r.linacGap
        ])
    );
    writeMarkdownStateTable(path.join(OUT_DIR, 'gap-backstop-by-state.md'), stateRows, payload.totals);

    const viable = payload.viableGaps.sort((a, b) =>
        a.state.localeCompare(b.state) || String(a.name).localeCompare(String(b.name))
    );
    writeCsv(
        path.join(OUT_DIR, 'viable-gap-walmarts.csv'),
        [
            'state',
            'name',
            'city',
            'street_address',
            'backstop_type',
            'nearest_hospital',
            'hospital_state',
            'drive_minutes'
        ],
        viable.map((w) => [
            w.state,
            w.name,
            w.city,
            w.street_address,
            w.backstopType,
            w.nearestHospital,
            w.hospitalState,
            w.driveMinutes != null ? w.driveMinutes.toFixed(1) : ''
        ])
    );

    const namesOnly = viable.map((w) => `${w.name} — ${w.city}, ${w.state} (${w.backstopType})`);
    fs.writeFileSync(path.join(OUT_DIR, 'viable-gap-walmart-names.txt'), namesOnly.join('\n') + '\n', 'utf8');
}

async function linacGapWalmartsForState(stateAbbr, walmartLocations, linacLocations) {
    const stateWalmarts = walmartLocations.filter((w) => w.state === stateAbbr);
    const validLinacs = linacRowsForDriveTimeOsrm(stateAbbr, linacLocations);
    const withCoords = stateWalmarts.filter(walmartRowHasValidCoords);
    const needsOsrm = validLinacs.length > 0 && withCoords.length > 0;
    const gaps = [];

    let durationsMatrix = null;
    if (needsOsrm) {
        durationsMatrix = await getDriveTimes(withCoords, validLinacs);
    }

    let rowIndex = 0;
    for (const walmart of stateWalmarts) {
        if (!walmartRowHasValidCoords(walmart)) {
            gaps.push(walmart);
            continue;
        }
        let isWithinRange = false;
        if (needsOsrm) {
            const row = durationsMatrix[rowIndex];
            rowIndex += 1;
            isWithinRange =
                Array.isArray(row) &&
                row.some((s) => s != null && s <= LINAC_THRESHOLD_SECONDS);
        }
        if (!isWithinRange) gaps.push(walmart);
    }
    return gaps;
}

function nearestBackstopFromRow(row, dests) {
    if (!Array.isArray(row) || dests.length === 0) return null;

    let bestSec = Infinity;
    let bestIdx = -1;
    for (let j = 0; j < row.length; j++) {
        const s = row[j];
        if (s != null && s <= HOSPITAL_BACKSTOP_THRESHOLD_SECONDS && s < bestSec) {
            bestSec = s;
            bestIdx = j;
        }
    }
    if (bestIdx < 0) return null;

    const h = dests[bestIdx];
    const type = String(h.TYPE ?? '').trim().toUpperCase();
    return {
        type,
        hospitalName: String(h.NAME ?? '').trim(),
        hospitalState: String(h.STATE ?? '').trim(),
        driveMinutes: bestSec / 60
    };
}

async function runAnalysis() {
    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const linacLocations = loadDataFromFile('./src/data/linac-locations.json');
    const hospitals = loadDataFromFile('./src/data/hospital-locations.json');

    const codes = [...new Set(walmartLocations.map((w) => w.state).filter(Boolean))].sort();

    const byState = [];
    const viableGaps = [];
    const totals = {
        linacGap: 0,
        viable: 0,
        systemic: 0,
        generalAcute: 0,
        criticalAccess: 0
    };

    for (const stateAbbr of codes) {
        const row = {
            state: stateAbbr,
            linacGap: 0,
            viable: 0,
            systemic: 0,
            generalAcute: 0,
            criticalAccess: 0
        };

        const gaps = await linacGapWalmartsForState(stateAbbr, walmartLocations, linacLocations);
        row.linacGap = gaps.length;
        totals.linacGap += gaps.length;

        const coordGaps = gaps.filter(walmartRowHasValidCoords);
        const dests = hospitalRowsForDriveTimeOsrm(stateAbbr, hospitals);

        let hospMatrix = null;
        if (coordGaps.length > 0 && dests.length > 0) {
            hospMatrix = await getDriveTimes(coordGaps, dests);
        }

        for (let gi = 0; gi < coordGaps.length; gi++) {
            const w = coordGaps[gi];
            const backstop = nearestBackstopFromRow(hospMatrix ? hospMatrix[gi] : null, dests);
            if (backstop == null) {
                row.systemic += 1;
                totals.systemic += 1;
            } else {
                row.viable += 1;
                totals.viable += 1;
                if (backstop.type === 'GENERAL ACUTE CARE') {
                    row.generalAcute += 1;
                    totals.generalAcute += 1;
                } else if (backstop.type === 'CRITICAL ACCESS') {
                    row.criticalAccess += 1;
                    totals.criticalAccess += 1;
                }
                viableGaps.push({
                    state: w.state,
                    name: w.name,
                    city: w.city,
                    street_address: w.street_address,
                    backstopType:
                        backstop.type === 'GENERAL ACUTE CARE'
                            ? 'General acute care'
                            : backstop.type === 'CRITICAL ACCESS'
                              ? 'Critical access'
                              : backstop.type,
                    nearestHospital: backstop.hospitalName,
                    hospitalState: backstop.hospitalState,
                    driveMinutes: backstop.driveMinutes
                });
            }
        }

        byState.push(row);
        process.stdout.write(`\r${stateAbbr} — ${totals.viable} viable`);
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        linacThresholdMinutes: 60,
        hospitalBackstopMinutes: 30,
        totals,
        byState,
        viableGaps
    };

    writeReports(payload);
    return payload;
}

async function main() {
    const fromJson = process.argv.includes('--from-json');
    if (fromJson) {
        if (!fs.existsSync(JSON_PATH)) {
            console.error(`Missing ${JSON_PATH} — run without --from-json first.`);
            process.exit(1);
        }
        const payload = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
        writeReports(payload);
        console.log(`Regenerated reports from ${JSON_PATH}`);
        console.log(`  ${path.join(OUT_DIR, 'gap-backstop-by-state.csv')}`);
        console.log(`  ${path.join(OUT_DIR, 'gap-backstop-by-state.md')}`);
        console.log(`  ${path.join(OUT_DIR, 'viable-gap-walmarts.csv')}`);
        console.log(`  ${path.join(OUT_DIR, 'viable-gap-walmart-names.txt')}`);
        return;
    }

    console.log('Running OSRM analysis (cache is per Node process; expect ~20–30 min cold)…');
    const payload = await runAnalysis();

    console.log('\n');
    console.log('LINAC threshold: 60 min | Hospital backstop: 30 min');
    console.log('Total LINAC-gap Walmarts:', payload.totals.linacGap);
    console.log('Viable gaps:', payload.totals.viable);
    console.log('Systemic gaps:', payload.totals.systemic);
    console.log(
        `General acute: ${payload.totals.generalAcute} (${((100 * payload.totals.generalAcute) / payload.totals.viable).toFixed(1)}% of viable)`
    );
    console.log(
        `Critical access: ${payload.totals.criticalAccess} (${((100 * payload.totals.criticalAccess) / payload.totals.viable).toFixed(1)}% of viable)`
    );
    console.log('\nWrote:');
    console.log(`  ${JSON_PATH}`);
    console.log(`  ${path.join(OUT_DIR, 'gap-backstop-by-state.csv')}`);
    console.log(`  ${path.join(OUT_DIR, 'gap-backstop-by-state.md')}`);
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-walmarts.csv')}`);
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-walmart-names.txt')}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
