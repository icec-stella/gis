/**
 * Tier 2: population within OSRM drive-time catchments of viable-gap Walmarts.
 * Reads originals + scripts/output/gap-backstop-analysis.json only; writes to scripts/output/.
 *
 *   node scripts/viable-gap-catchment-population.js
 *   CATCHMENT_MINUTES=30 node scripts/viable-gap-catchment-population.js
 *   CATCHMENT_STORE_LIMIT=5 node scripts/viable-gap-catchment-population.js   # smoke test
 *
 * Census: 2020 tract populations + internal point (CenPop2020_Mean_TR.txt, ~3.4 MB).
 * OSRM: same Table service as server.js (public demo).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const {
    getDriveTimes,
    loadDataFromFile,
    geoLatLonFromRow
} = require('../server.js');

const INPUT_JSON = path.join(__dirname, 'output', 'gap-backstop-analysis.json');
const OUT_DIR = path.join(__dirname, 'output');
const CACHE_DIR = path.join(__dirname, 'cache');
const TRACT_POP_URL =
    'https://www2.census.gov/geo/docs/reference/cenpop2020/tract/CenPop2020_Mean_TR.txt';
const TRACT_POP_CACHE = path.join(CACHE_DIR, 'CenPop2020_Mean_TR.txt');

const CATCHMENT_MINUTES = Number.parseInt(process.env.CATCHMENT_MINUTES || '30', 10);
const CATCHMENT_SECONDS = CATCHMENT_MINUTES * 60;
const RADIUS_BUFFER_MILES = Number.parseFloat(process.env.CATCHMENT_RADIUS_MILES || '40');
const STORE_LIMIT = Number.parseInt(process.env.CATCHMENT_STORE_LIMIT || '0', 10) || 0;

const STATE_ABBR_TO_FIPS = {
    AL: '01',
    AK: '02',
    AZ: '04',
    AR: '05',
    CA: '06',
    CO: '08',
    CT: '09',
    DE: '10',
    DC: '11',
    FL: '12',
    GA: '13',
    HI: '15',
    ID: '16',
    IL: '17',
    IN: '18',
    IA: '19',
    KS: '20',
    KY: '21',
    LA: '22',
    ME: '23',
    MD: '24',
    MA: '25',
    MI: '26',
    MN: '27',
    MS: '28',
    MO: '29',
    MT: '30',
    NE: '31',
    NV: '32',
    NH: '33',
    NJ: '34',
    NM: '35',
    NY: '36',
    NC: '37',
    ND: '38',
    OH: '39',
    OK: '40',
    OR: '41',
    PA: '42',
    PR: '72',
    RI: '44',
    SC: '45',
    SD: '46',
    TN: '47',
    TX: '48',
    UT: '49',
    VT: '50',
    VA: '51',
    WA: '53',
    WV: '54',
    WI: '55',
    WY: '56'
};

/** PR tract centroids not in CenPop2020 — 2020 municipio fallback (same as population script). */
const PR_PLACE_POP_FALLBACK = {
    Guayama: 32786,
    Hatillo: 39814,
    Ponce: 137491,
    'Santa Isabel': 20281
};

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

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const file = fs.createWriteStream(dest);
        https
            .get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    file.close();
                    fs.unlinkSync(dest);
                    return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed HTTP ${res.statusCode}: ${url}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
            })
            .on('error', reject);
    });
}

function parseCoord(v) {
    const n = Number.parseFloat(String(v ?? '').replace(/^\+/, ''));
    return Number.isFinite(n) ? n : NaN;
}

function tractGeoId(stateFp, countyFp, tractCe) {
    return (
        String(stateFp).padStart(2, '0') +
        String(countyFp).padStart(3, '0') +
        String(tractCe).padStart(6, '0')
    );
}

function haversineMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.7613;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizeKey(s) {
    return String(s ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function findWalmartCoords(gap, walmarts) {
    const exact = walmarts.find(
        (w) =>
            w.state === gap.state &&
            normalizeKey(w.city) === normalizeKey(gap.city) &&
            normalizeKey(w.name) === normalizeKey(gap.name) &&
            normalizeKey(w.street_address) === normalizeKey(gap.street_address)
    );
    if (exact) return exact;

    const byName = walmarts.filter(
        (w) =>
            w.state === gap.state &&
            normalizeKey(w.city) === normalizeKey(gap.city) &&
            normalizeKey(w.name) === normalizeKey(gap.name)
    );
    if (byName.length === 1) return byName[0];
    return null;
}

async function loadTracts() {
    if (!fs.existsSync(TRACT_POP_CACHE)) {
        console.log(`Downloading Census tract populations…\n  ${TRACT_POP_URL}`);
        await downloadFile(TRACT_POP_URL, TRACT_POP_CACHE);
    }
    const text = fs.readFileSync(TRACT_POP_CACHE, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const tracts = [];
    const byState = new Map();

    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 6) continue;
        const stateFp = parts[0].trim();
        const countyFp = parts[1].trim();
        const tractCe = parts[2].trim();
        const population = Number.parseInt(parts[3], 10);
        const lat = parseCoord(parts[4]);
        const lon = parseCoord(parts[5]);
        if (!Number.isFinite(population) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const tract = {
            geoid: tractGeoId(stateFp, countyFp, tractCe),
            stateFp,
            countyFp,
            tractCe,
            population,
            latitude: lat,
            longitude: lon
        };
        tracts.push(tract);
        if (!byState.has(stateFp)) byState.set(stateFp, []);
        byState.get(stateFp).push(tract);
    }
    return { tracts, byState, vintage: '2020 Census (CenPop2020 tract internal point + POPULATION)' };
}

function tractsWithinRadius(storeLat, storeLon, stateTracts, miles) {
    const out = [];
    for (const t of stateTracts) {
        if (haversineMiles(storeLat, storeLon, t.latitude, t.longitude) <= miles) {
            out.push(t);
        }
    }
    return out;
}

async function reachableTractsForStore(storeRow, candidateTracts) {
    if (candidateTracts.length === 0) return [];

    const source = {
        latitude: storeRow.latitude,
        longitude: storeRow.longitude,
        name: storeRow.name
    };
    const destinations = candidateTracts.map((t) => ({
        latitude: t.latitude,
        longitude: t.longitude,
        geoid: t.geoid
    }));

    const matrix = await getDriveTimes([source], destinations);
    const row = matrix[0];
    if (!Array.isArray(row)) return [];

    const reached = [];
    for (let j = 0; j < candidateTracts.length; j++) {
        const sec = row[j];
        if (sec != null && sec <= CATCHMENT_SECONDS) {
            reached.push(candidateTracts[j]);
        }
    }
    return reached;
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

async function main() {
    if (!fs.existsSync(INPUT_JSON)) {
        console.error(`Missing ${INPUT_JSON}. Run: node scripts/gap-backstop-hospital-type.js`);
        process.exit(1);
    }

    const analysis = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
    let viableGaps = analysis.viableGaps || [];
    if (STORE_LIMIT > 0) {
        viableGaps = viableGaps.slice(0, STORE_LIMIT);
        console.log(`CATCHMENT_STORE_LIMIT=${STORE_LIMIT} (smoke test)`);
    }

    const walmarts = loadDataFromFile('./src/data/walmart-locations.json');
    const { byState, vintage: tractVintage } = await loadTracts();

    const storeResults = [];
    const unionTracts = new Map(); // geoid -> tract
    let naiveOverlapSum = 0;
    let prFallbackPop = 0;
    let skippedNoCoords = 0;

    for (let i = 0; i < viableGaps.length; i++) {
        const gap = viableGaps[i];
        const walmart = findWalmartCoords(gap, walmarts);
        if (!walmart) {
            skippedNoCoords += 1;
            storeResults.push({
                state: gap.state,
                name: gap.name,
                city: gap.city,
                street_address: gap.street_address,
                status: 'walmart_not_found',
                tractCount: 0,
                catchmentPopulation: 0
            });
            continue;
        }

        const { lat, lon } = geoLatLonFromRow(walmart);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            skippedNoCoords += 1;
            continue;
        }

        const stateFp = STATE_ABBR_TO_FIPS[gap.state];
        if (!stateFp) continue;

        if (gap.state === 'PR') {
            const pop = PR_PLACE_POP_FALLBACK[gap.city];
            if (pop) {
                prFallbackPop += pop;
                storeResults.push({
                    state: gap.state,
                    name: gap.name,
                    city: gap.city,
                    street_address: gap.street_address,
                    latitude: lat,
                    longitude: lon,
                    status: 'pr_municipio_fallback_2020',
                    tractCount: 0,
                    catchmentPopulation: pop
                });
            }
            process.stdout.write(`\r${i + 1}/${viableGaps.length} ${gap.city}, ${gap.state} (PR fallback)`);
            continue;
        }

        const stateTracts = byState.get(stateFp) || [];
        const candidates = tractsWithinRadius(lat, lon, stateTracts, RADIUS_BUFFER_MILES);
        const reached = await reachableTractsForStore(
            { latitude: lat, longitude: lon, name: walmart.name },
            candidates
        );

        let storePop = 0;
        for (const t of reached) {
            storePop += t.population;
            if (!unionTracts.has(t.geoid)) {
                unionTracts.set(t.geoid, t);
            }
        }
        naiveOverlapSum += storePop;

        storeResults.push({
            state: gap.state,
            name: gap.name,
            city: gap.city,
            street_address: gap.street_address,
            latitude: lat,
            longitude: lon,
            status: 'ok',
            candidateTracts: candidates.length,
            tractCount: reached.length,
            catchmentPopulation: storePop
        });

        process.stdout.write(
            `\r${i + 1}/${viableGaps.length} ${gap.city}, ${gap.state} — ${reached.length} tracts`
        );
    }

    let unionPop = 0;
    for (const t of unionTracts.values()) {
        unionPop += t.population;
    }
    unionPop += prFallbackPop;

    const tier1Path = path.join(OUT_DIR, 'viable-gap-population-summary.json');
    let tier1PlacePop = null;
    if (fs.existsSync(tier1Path)) {
        tier1PlacePop = JSON.parse(fs.readFileSync(tier1Path, 'utf8')).sumUniqueCityPopulations;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    writeCsv(
        path.join(OUT_DIR, 'viable-gap-catchment-by-store.csv'),
        [
            'state',
            'name',
            'city',
            'street_address',
            'latitude',
            'longitude',
            'status',
            'candidate_tracts',
            'tract_count',
            'catchment_population'
        ],
        storeResults.map((r) => [
            r.state,
            r.name,
            r.city,
            r.street_address,
            r.latitude ?? '',
            r.longitude ?? '',
            r.status,
            r.candidateTracts ?? '',
            r.tractCount,
            r.catchmentPopulation
        ])
    );

    writeCsv(
        path.join(OUT_DIR, 'viable-gap-catchment-tracts-union.csv'),
        ['geoid', 'state_fips', 'county_fips', 'tract_ce', 'population'],
        [...unionTracts.values()]
            .sort((a, b) => a.geoid.localeCompare(b.geoid))
            .map((t) => [t.geoid, t.stateFp, t.countyFp, t.tractCe, t.population])
    );

    const summary = {
        generatedAt: new Date().toISOString(),
        method: 'tier2_osrm_tract_catchment_union',
        catchmentDriveMinutes: CATCHMENT_MINUTES,
        haversinePrefilterMiles: RADIUS_BUFFER_MILES,
        tractPopulationVintage: tractVintage,
        osrmService: 'http://router.project-osrm.org/table/v1/driving',
        viableGapStoresProcessed: viableGaps.length,
        storesWithTractCatchment: storeResults.filter((r) => r.status === 'ok').length,
        prMunicipioFallbackStores: storeResults.filter((r) => r.status === 'pr_municipio_fallback_2020')
            .length,
        skippedNoCoords,
        uniqueTractsInUnion: unionTracts.size,
        unionPopulation: unionPop,
        naiveSumOfStoreCatchments: naiveOverlapSum + prFallbackPop,
        tier1PlacePopulationProxy: tier1PlacePop,
        notes: [
            'unionPopulation counts each 2020 tract once across all stores (deduplicated).',
            'naiveSumOfStoreCatchments sums per-store tract populations and double-counts overlap.',
            'PR stores use 2020 municipio population fallback (tract file has no PR).',
            'Tract centroids approximate reachability; not block-level areal weighting.'
        ]
    };
    summary.overlapPopulation = summary.naiveSumOfStoreCatchments - summary.unionPopulation;

    fs.writeFileSync(
        path.join(OUT_DIR, 'viable-gap-catchment-summary.json'),
        JSON.stringify(summary, null, 2),
        'utf8'
    );

    console.log('\n\nTier 2 catchment analysis complete');
    console.log(`  Catchment: ${CATCHMENT_MINUTES} min OSRM drive (prefilter ${RADIUS_BUFFER_MILES} mi)`);
    console.log(`  Union population (deduplicated tracts): ${unionPop.toLocaleString()}`);
    console.log(`  Naive per-store sum (with overlap):    ${summary.naiveSumOfStoreCatchments.toLocaleString()}`);
    console.log(`  Overlap (naive − union):               ${summary.overlapPopulation.toLocaleString()}`);
    console.log(`  Unique tracts in union: ${unionTracts.size}`);
    if (tier1PlacePop != null) {
        console.log(`  Tier 1 place proxy (comparison):       ${tier1PlacePop.toLocaleString()}`);
    }
    console.log('\nWrote:');
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-catchment-summary.json')}`);
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-catchment-by-store.csv')}`);
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-catchment-tracts-union.csv')}`);
}

module.exports = { main, tractGeoId, haversineMiles };
