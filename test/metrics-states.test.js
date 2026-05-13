/**
 * Integration checks for GET /api/metrics on ten representative states:
 * fixture-backed totals plus OSRM success (public router).
 *
 * Run: npm test
 * Requires network. Skip: SKIP_OSRM_METRICS_TESTS=1
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const request = require('supertest');

const SKIP = /^1|true|yes$/i.test(String(process.env.SKIP_OSRM_METRICS_TESTS || ''));

const {
    app,
    linacRowsForDriveTimeOsrm,
    linacRowHasValidCoords,
    walmartRowHasValidCoords
} = require('../server.js');

const DATA_DIR = path.join(__dirname, '..', 'src', 'data');

function loadJson(name) {
    const p = path.join(DATA_DIR, name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Variety: isolated (AK, HI, PR), large/medium continental, sparse. */
const TEN_STATES = ['AK', 'TX', 'CA', 'NH', 'ND', 'DE', 'FL', 'HI', 'PR', 'WY'];

function expectedTotalsFromFixture(stateAbbr, walmartLocations, linacLocations) {
    const stores = walmartLocations.filter((w) => w.state === stateAbbr);
    const centers = linacLocations.filter((c) => c.States === stateAbbr);
    let linacUnits = 0;
    centers.forEach((c) => {
        linacUnits += parseInt(c['Number of LINACs'], 10) || 0;
    });
    return {
        totalWalmarts: stores.length,
        cityCentersWithinRange: centers.length,
        linacsWithinRange: linacUnits
    };
}

describe(
    '/api/metrics — ten states vs fixtures + anchor rules',
    { skip: SKIP, concurrency: false, timeout: 900000 },
    () => {
        let walmartLocations;
        let linacLocations;

        before(() => {
            walmartLocations = loadJson('walmart-locations.json');
            linacLocations = loadJson('linac-locations.json');

            const continentalAnchors = linacRowsForDriveTimeOsrm('TX', linacLocations).length;
            console.log(`[tests] continental LINAC anchor count (via TX helper)=${continentalAnchors}`);

            assert.ok(continentalAnchors > 100, 'continental pool should include many LINAC rows');

            for (const iso of ['AK', 'HI', 'PR']) {
                const nIso = linacLocations.filter((l) => linacRowHasValidCoords(l) && l.States === iso).length;
                assert.equal(
                    linacRowsForDriveTimeOsrm(iso, linacLocations).length,
                    nIso,
                    `isolated anchors for ${iso}`
                );
            }
        });

        const DRIVE_MIN = 60;

        for (const stateAbbr of TEN_STATES) {
            it(`${stateAbbr}: 200, totals match fixtures, gaps bounded`, { timeout: 180000 }, async () => {
                const expected = expectedTotalsFromFixture(stateAbbr, walmartLocations, linacLocations);

                const res = await request(app)
                    .get('/api/metrics')
                    .query({ state: stateAbbr, driveTimeMinutes: String(DRIVE_MIN) })
                    .set('Accept', 'application/json');

                assert.equal(
                    res.status,
                    200,
                    `body=${typeof res.body === 'object' ? JSON.stringify(res.body) : String(res.text)}`
                );

                const b = res.body;
                for (const k of ['walmartsOutsideRange', 'totalWalmarts', 'cityCentersWithinRange', 'linacsWithinRange']) {
                    assert.ok(k in b, `missing ${k}`);
                    assert.equal(typeof b[k], 'number');
                    assert.ok(Number.isFinite(b[k]));
                }

                assert.equal(b.totalWalmarts, expected.totalWalmarts, 'total Walmart count');
                assert.equal(b.cityCentersWithinRange, expected.cityCentersWithinRange, 'LINAC center count');
                assert.equal(b.linacsWithinRange, expected.linacsWithinRange, 'LINAC unit sum');

                assert.ok(b.walmartsOutsideRange >= 0, 'outside non-negative');
                assert.ok(b.walmartsOutsideRange <= b.totalWalmarts, 'outside cannot exceed stores in state');

                const validStores = walmartLocations.filter(
                    (w) => w.state === stateAbbr && walmartRowHasValidCoords(w)
                ).length;
                const anchors = linacRowsForDriveTimeOsrm(stateAbbr, linacLocations).length;

                if (anchors === 0 || validStores === 0) {
                    assert.ok(
                        b.walmartsOutsideRange === b.totalWalmarts || b.totalWalmarts === 0,
                        'no OSRM anchors or no valid coords ⇒ all/outside heuristic'
                    );
                }
            });
        }
    }
);
