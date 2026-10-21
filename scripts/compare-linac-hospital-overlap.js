/**
 * Compare linac-locations.json vs hospital-locations.json: spatial/name overlap.
 *
 *   node scripts/compare-linac-hospital-overlap.js
 *   node scripts/compare-linac-hospital-overlap.js --eps 0.005
 *
 * Matching (same state required):
 *   - coordinates within --eps degrees (~500m default), and/or
 *   - normalized / compact name match (handles ADVENT HEALTH vs ADVENTHEALTH)
 *
 * Reports how many LINAC sites still have a row in the hospital file (any vs
 * eligible backstop), and how many hospitals match a LINAC (potential double-count).
 */

const fs = require('fs');
const path = require('path');

const {
    loadDataFromFile,
    linacRowHasValidCoords,
    hospitalRowEligibleRoute,
    geoLatLonFromRow
} = require('../server.js');

function hospitalRowHasValidCoords(h) {
    const { lat, lon } = geoLatLonFromRow(h);
    return Number.isFinite(lat) && Number.isFinite(lon);
}

const COORD_EPS = parseFloat(process.argv.includes('--eps')
    ? process.argv[process.argv.indexOf('--eps') + 1]
    : '0.005');

function norm(s) {
    return String(s)
        .toUpperCase()
        .replace(/['']/g, '')
        .replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\bST\b/g, 'SAINT')
        .replace(/\bREG\b/g, 'REGIONAL')
        .replace(/\bMED\b/g, 'MEDICAL')
        .replace(/\bCTR\b/g, 'CENTER')
        .replace(/\bSYS\b/g, 'SYSTEM')
        .replace(/\s+/g, ' ')
        .trim();
}

function compact(s) {
    return norm(s).replace(/\s+/g, '');
}

function namesMatch(a, b) {
    return norm(a) === norm(b) || compact(a) === compact(b);
}

function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

function near(a, b, eps = COORD_EPS) {
    return Math.abs(a - b) <= eps;
}

function coordMatch(linac, hospital, eps = COORD_EPS) {
    const lLat = num(linac.Latitude);
    const lLon = num(linac.Longitude);
    const hLat = num(hospital.LATITUDE);
    const hLon = num(hospital.LONGITUDE);
    if (lLat == null || lLon == null || hLat == null || hLon == null) return false;
    return near(lLat, hLat, eps) && near(lLon, hLon, eps);
}

function stateMatch(linac, hospital) {
    return norm(linac.States) === norm(hospital.STATE);
}

function findHospitalMatches(linac, hospitals) {
    const hits = [];
    for (const h of hospitals) {
        if (!stateMatch(linac, h)) continue;
        const byCoord = coordMatch(linac, h);
        const byName = namesMatch(linac['LINAC Name'], h.NAME);
        if (byCoord || byName) {
            hits.push({
                hospital: h,
                byCoord,
                byName,
                eligible: hospitalRowEligibleRoute(h)
            });
        }
    }
    return hits;
}

function main() {
    const linacs = loadDataFromFile('./src/data/linac-locations.json');
    const hospitals = loadDataFromFile('./src/data/hospital-locations.json');

    const linacsWithCoords = linacs.filter(linacRowHasValidCoords);
    const hospitalsWithCoords = hospitals.filter(hospitalRowHasValidCoords);
    const eligibleHospitals = hospitals.filter(hospitalRowEligibleRoute);

    let linacAnyMatch = 0;
    let linacEligibleMatch = 0;
    let linacCoordMatch = 0;
    let linacNameOnlyMatch = 0;
    let linacNoMatch = 0;

    const noMatchSamples = [];
    const multiMatch = [];

    for (const l of linacsWithCoords) {
        const hits = findHospitalMatches(l, hospitalsWithCoords);
        const eligibleHits = hits.filter((x) => x.eligible);

        if (hits.length === 0) {
            linacNoMatch++;
            if (noMatchSamples.length < 15) {
                noMatchSamples.push(`${l['LINAC Name']} (${l.Cities}, ${l.States})`);
            }
        } else {
            linacAnyMatch++;
            if (eligibleHits.length > 0) linacEligibleMatch++;
            if (hits.some((x) => x.byCoord)) linacCoordMatch++;
            if (hits.some((x) => x.byName && !x.byCoord)) linacNameOnlyMatch++;
            if (hits.length > 1 && multiMatch.length < 10) {
                multiMatch.push({
                    linac: l['LINAC Name'],
                    hospitals: hits.map((x) => x.hospital.NAME)
                });
            }
        }
    }

    // Hospitals that match at least one LINAC (inverse)
    const hospitalMatchedLinacIds = new Set();
    for (const l of linacsWithCoords) {
        for (const h of hospitalsWithCoords) {
            if (!stateMatch(l, h)) continue;
            if (coordMatch(l, h) || namesMatch(l['LINAC Name'], h.NAME)) {
                hospitalMatchedLinacIds.add(h.ID ?? `${h.NAME}|${h.STATE}|${h.CITY}`);
            }
        }
    }

    console.log('=== Dataset sizes ===');
    console.log(`LINAC rows:                    ${linacs.length} (${linacsWithCoords.length} with valid coords)`);
    console.log(`Hospital rows (raw):           ${hospitals.length}`);
    console.log(`Hospital rows (valid coords):  ${hospitalsWithCoords.length}`);
    console.log(`Hospital rows (eligible backstop): ${eligibleHospitals.length}`);

    console.log('\n=== LINAC → hospital overlap (eps =', COORD_EPS, 'deg) ===');
    console.log(`LINACs with ≥1 hospital match (any):     ${linacAnyMatch}`);
    console.log(`LINACs with ≥1 eligible hospital match:  ${linacEligibleMatch}`);
    console.log(`LINACs with coord match to a hospital:   ${linacCoordMatch}`);
    console.log(`LINACs with name-only match (no coord):  ${linacNameOnlyMatch}`);
    console.log(`LINACs with no hospital match:           ${linacNoMatch}`);

    console.log('\n=== Hospital → LINAC overlap (inverse) ===');
    console.log(`Hospitals matching ≥1 LINAC:             ${hospitalMatchedLinacIds.size}`);
    console.log(`Hospitals with no LINAC match:           ${hospitalsWithCoords.length - hospitalMatchedLinacIds.size}`);

    console.log('\n=== Interpretation ===');
    console.log(
        'Expected after dedupe: most of the 91 hospital-hosted LINAC adds should NOT appear as eligible hospitals.'
    );
    console.log(
        'Freestanding LINAC centers often have no HIFLD hospital row at the same coords/name — that is normal.'
    );

    if (noMatchSamples.length) {
        console.log('\nSample LINACs with no hospital match:');
        noMatchSamples.forEach((s) => console.log('  ', s));
    }
    if (multiMatch.length) {
        console.log('\nSample LINACs matching multiple hospitals:');
        multiMatch.forEach((m) => {
            console.log('  ', m.linac);
            m.hospitals.forEach((h) => console.log('    ->', h));
        });
    }
}

main();
