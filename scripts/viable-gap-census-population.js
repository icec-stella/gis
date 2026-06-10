/**
 * Cross-reference viable LINAC-gap Walmarts with U.S. Census Bureau place population
 * estimates (Population Estimates Program, July 1, 2024).
 *
 * Prerequisite: scripts/output/gap-backstop-analysis.json (from gap-backstop-hospital-type.js)
 *
 *   node scripts/viable-gap-census-population.js
 *
 * Downloads Census sub-est2024.csv on first run (~7 MB) to scripts/cache/.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const INPUT_JSON = path.join(__dirname, 'output', 'gap-backstop-analysis.json');
const CACHE_DIR = path.join(__dirname, 'cache');
const CENSUS_CSV = path.join(CACHE_DIR, 'sub-est2024.csv');
const CENSUS_URL =
    'https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv';
const OUT_DIR = path.join(__dirname, 'output');

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

/**
 * CDPs / PR municipios missing from PEP cities file — 2020 Decennial Census counts.
 * Source: U.S. Census Bureau 2020 Census Redistricting Data (P1_001N).
 */
const MANUAL_PLACE_OVERRIDES = {
    'AZ|Claypool': { censusPlaceName: 'Claypool CDP (2020 Census)', population: 1538 },
    'AZ|Fort Mohave': { censusPlaceName: 'Fort Mohave CDP (2020 Census)', population: 16206 },
    'HI|Lihue': { censusPlaceName: 'Lihue CDP (2020 Census)', population: 7237 },
    'NV|Pahrump': { censusPlaceName: 'Pahrump CDP (2020 Census)', population: 44738 },
    'PR|Guayama': { censusPlaceName: 'Guayama municipio (2020 Census)', population: 32786 },
    'PR|Hatillo': { censusPlaceName: 'Hatillo municipio (2020 Census)', population: 39814 },
    'PR|Ponce': { censusPlaceName: 'Ponce municipio (2020 Census)', population: 137491 },
    'PR|Santa Isabel': { censusPlaceName: 'Santa Isabel municipio (2020 Census)', population: 20281 },
    'NH|North Conway': { censusPlaceName: 'North Conway CDP (2020 Census)', population: 2052 },
    'NH|Woodsville': { censusPlaceName: 'Woodsville CDP (2020 Census)', population: 1126 }
};

/** Walmart city strings that differ from Census place names. */
const CITY_ALIASES = {
    'AR|Heber Spgs': 'Heber Springs',
    'AR|Mcgehee': 'McGehee',
    'AR|West Helena': 'Helena-West Helena',
    'MI|Sault Sainte Marie': 'Sault Ste. Marie',
    'NE|Mccook': 'McCook',
    'NM|Truth Or Consequences': 'Truth or Consequences',
    'WI|Prairie Du Chien': 'Prairie du Chien'
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
                    reject(new Error(`Census download failed: HTTP ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
            })
            .on('error', reject);
    });
}

function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                cur += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function normalizeWalmartCity(name) {
    let s = String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '')
        .replace(/['’]/g, '');
    s = s.replace(/\b(saint|st)\b/g, 'saint');
    s = s.replace(/\b(fort|ft)\b/g, 'fort');
    s = s.replace(/\b(mt|mount)\b/g, 'mount');
    s = s.replace(/\s+/g, ' ');
    return s.trim();
}

/** Strip Census administrative suffix ("Florence city" → "florence"). */
function normalizeCensusPlaceName(name) {
    let s = normalizeWalmartCity(name);
    s = s.replace(
        /\s+(city|town|village|borough|cdp|municipality|plantation|metro government|unified government|consolidated government)\s*$/i,
        ''
    );
    return s.trim();
}

function walmartCityForMatch(state, city) {
    const alias = CITY_ALIASES[`${state}|${city}`];
    return alias || city;
}

function loadCensusPlaces() {
    const text = fs.readFileSync(CENSUS_CSV, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    const popCol = 'POPESTIMATE2024';
    if (!(popCol in idx)) {
        throw new Error(`Expected ${popCol} in Census CSV`);
    }

    /** stateFips -> normalizedName -> [{ censusName, population, placeFips }] */
    const byState = new Map();

    const ACCEPTED_SUMLEV = new Set(['162', '061']); // 162 = city/town/CDP; 061 = New England town, etc.

    for (let li = 1; li < lines.length; li++) {
        const row = parseCsvLine(lines[li]);
        const sumlev = row[idx.SUMLEV];
        if (!ACCEPTED_SUMLEV.has(sumlev)) continue;
        const stateFips = row[idx.STATE];
        const censusName = row[idx.NAME];
        const population = Number.parseInt(row[idx[popCol]], 10);
        if (!Number.isFinite(population)) continue;

        const key = normalizeCensusPlaceName(censusName);
        if (!byState.has(stateFips)) byState.set(stateFips, new Map());
        const stateMap = byState.get(stateFips);
        if (!stateMap.has(key)) stateMap.set(key, []);
        stateMap.get(key).push({
            censusName,
            population,
            placeFips: row[idx.PLACE],
            sumlev
        });
    }

    // Prefer SUMLEV 162 over 061 when both map to the same normalized name.
    for (const stateMap of byState.values()) {
        for (const [key, entries] of stateMap) {
            const has162 = entries.some((e) => e.sumlev === '162');
            if (has162) {
                stateMap.set(
                    key,
                    entries.filter((e) => e.sumlev === '162')
                );
            }
        }
    }
    return { byState, vintage: '2024-07-01 PEP (POPESTIMATE2024)' };
}

function matchPlace(stateAbbr, walmartCity, byState) {
    const manualKey = `${stateAbbr}|${walmartCity}`;
    if (MANUAL_PLACE_OVERRIDES[manualKey]) {
        const o = MANUAL_PLACE_OVERRIDES[manualKey];
        return {
            matched: true,
            censusPlaceName: o.censusPlaceName,
            population: o.population,
            matchMethod: 'manual_2020_census'
        };
    }

    const stateFips = STATE_ABBR_TO_FIPS[stateAbbr];
    if (!stateFips) {
        return { matched: false, reason: 'unknown_state' };
    }
    const stateMap = byState.get(stateFips);
    if (!stateMap) {
        return { matched: false, reason: 'no_census_places_for_state' };
    }

    const city = walmartCityForMatch(stateAbbr, walmartCity);
    const key = normalizeWalmartCity(city);
    let candidates = stateMap.get(key) || [];

    if (candidates.length === 0) {
        // Substring fallback: unique place whose normalized name contains the city key or vice versa
        const all = [];
        for (const [placeKey, entries] of stateMap) {
            if (placeKey.includes(key) || key.includes(placeKey)) {
                all.push(...entries.map((e) => ({ ...e, placeKey })));
            }
        }
        if (all.length === 1) {
            candidates = [all[0]];
        } else if (all.length > 1) {
            // Prefer exact start match
            const starts = all.filter((e) => e.placeKey.startsWith(key) || key.startsWith(e.placeKey));
            if (starts.length === 1) candidates = [starts[0]];
        }
    }

    if (candidates.length === 0) {
        return { matched: false, reason: 'no_place_match', lookupCity: city };
    }
    if (candidates.length > 1) {
        // Pick largest population when ambiguous (e.g. duplicate legal names rare)
        candidates.sort((a, b) => b.population - a.population);
    }
    const best = candidates[0];
    return {
        matched: true,
        censusPlaceName: best.censusName,
        population: best.population,
        matchMethod: candidates.length > 1 ? 'ambiguous_largest_pop' : 'normalized_name'
    };
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

    if (!fs.existsSync(CENSUS_CSV)) {
        console.log(`Downloading Census place population file…\n  ${CENSUS_URL}`);
        await downloadFile(CENSUS_URL, CENSUS_CSV);
        console.log(`Saved ${CENSUS_CSV}`);
    }

    const { byState, vintage } = loadCensusPlaces();
    const analysis = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
    const viableGaps = analysis.viableGaps || [];
    if (viableGaps.length === 0) {
        console.error('No viableGaps in analysis JSON.');
        process.exit(1);
    }

    const storeRows = [];
    const cityMap = new Map();

    for (const g of viableGaps) {
        const match = matchPlace(g.state, g.city, byState);
        const row = {
            state: g.state,
            walmartName: g.name,
            walmartCity: g.city,
            backstopType: g.backstopType,
            censusPlaceName: match.matched ? match.censusPlaceName : '',
            populationEstimate: match.matched ? match.population : null,
            populationVintage: vintage,
            matchStatus: match.matched ? 'matched' : match.reason,
            lookupCity: match.lookupCity || walmartCityForMatch(g.state, g.city)
        };
        storeRows.push(row);

        const cityKey = `${g.state}|${g.city}`;
        if (!cityMap.has(cityKey)) {
            cityMap.set(cityKey, {
                state: g.state,
                walmartCity: g.city,
                storeCount: 0,
                censusPlaceName: row.censusPlaceName,
                populationEstimate: row.populationEstimate,
                matchStatus: row.matchStatus
            });
        }
        cityMap.get(cityKey).storeCount += 1;
    }

    const cityRows = [...cityMap.values()].sort(
        (a, b) => a.state.localeCompare(b.state) || a.walmartCity.localeCompare(b.walmartCity)
    );

    const matchedCities = cityRows.filter((c) => c.matchStatus === 'matched');
    const unmatchedCities = cityRows.filter((c) => c.matchStatus !== 'matched');
    const uniqueCityPopulation = matchedCities.reduce((s, c) => s + (c.populationEstimate || 0), 0);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    writeCsv(
        path.join(OUT_DIR, 'viable-gap-walmarts-with-population.csv'),
        [
            'state',
            'walmart_name',
            'walmart_city',
            'backstop_type',
            'census_place_name',
            'population_estimate',
            'population_vintage',
            'match_status'
        ],
        storeRows.map((r) => [
            r.state,
            r.walmartName,
            r.walmartCity,
            r.backstopType,
            r.censusPlaceName,
            r.populationEstimate ?? '',
            r.populationVintage,
            r.matchStatus
        ])
    );

    writeCsv(
        path.join(OUT_DIR, 'viable-gap-cities-population.csv'),
        [
            'state',
            'walmart_city',
            'store_count',
            'census_place_name',
            'population_estimate',
            'population_vintage',
            'match_status'
        ],
        cityRows.map((c) => [
            c.state,
            c.walmartCity,
            c.storeCount,
            c.censusPlaceName,
            c.populationEstimate ?? '',
            vintage,
            c.matchStatus
        ])
    );

    const summary = {
        generatedAt: new Date().toISOString(),
        source: 'U.S. Census Bureau Population Estimates Program (sub-est2024.csv)',
        populationVintage: vintage,
        viableGapStores: viableGaps.length,
        uniqueCityStatePairs: cityRows.length,
        matchedCityStatePairs: matchedCities.length,
        unmatchedCityStatePairs: unmatchedCities.length,
        sumUniqueCityPopulations: uniqueCityPopulation,
        unmatched: unmatchedCities.map((c) => `${c.walmartCity}, ${c.state} (${c.matchStatus})`)
    };
    fs.writeFileSync(
        path.join(OUT_DIR, 'viable-gap-population-summary.json'),
        JSON.stringify(summary, null, 2),
        'utf8'
    );

    console.log('Population crosswalk complete');
    console.log(`  Viable-gap stores: ${summary.viableGapStores}`);
    console.log(`  Unique city–state pairs: ${summary.uniqueCityStatePairs}`);
    console.log(`  Matched to Census place: ${summary.matchedCityStatePairs}`);
    console.log(`  Unmatched: ${summary.unmatchedCityStatePairs}`);
    console.log(
        `  Sum of matched city populations (deduplicated, not summed per store): ${uniqueCityPopulation.toLocaleString()}`
    );
    if (unmatchedCities.length > 0) {
        console.log('\nUnmatched cities:');
        for (const u of unmatchedCities) {
            console.log(`  - ${u.walmartCity}, ${u.state}`);
        }
    }
    console.log('\nWrote:');
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-walmarts-with-population.csv')}`);
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-cities-population.csv')}`);
    console.log(`  ${path.join(OUT_DIR, 'viable-gap-population-summary.json')}`);
}
