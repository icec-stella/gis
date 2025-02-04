const express = require('express');
const cors = require('cors');
const path = require('path');
const NodeCache = require('node-cache');
const fetch = require('node-fetch');
const https = require('https');
const axios = require('axios');

// Load the JSON data
const walmartLocations = require('./src/data/walmart-locations.json');
const cityCenters = require('./src/data/city-centers.json');
const linacLocations = require('./src/data/linac-locations.json');

// Add detailed startup logging
console.log('\n=== SERVER STARTUP ===');
console.log(`Total Walmart locations loaded: ${walmartLocations.length}`);
console.log('Walmart locations by state:');
const stateCount = {};
walmartLocations.forEach(w => {
    stateCount[w.state] = (stateCount[w.state] || 0) + 1;
});
Object.entries(stateCount).sort().forEach(([state, count]) => {
    console.log(`${state}: ${count} locations`);
});

console.log('Loaded data:');
console.log(`Total Walmart locations: ${walmartLocations.length}`);
console.log('Sample Walmart location:', walmartLocations[0]);

const app = express();

// Try to use the specified port
function tryPort(port) {
    const server = app.listen(port)
        .on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`Port ${port} is already in use. Please free up the port or use a different one.`);
                process.exit(1);
            }
        })
        .on('listening', () => {
            console.log(`Server running at http://localhost:${port}`);
        });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Add stronger cache control headers for all responses
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Expires', '-1');
    res.set('Pragma', 'no-cache');
    next();
});

// Reduce the cache TTL
const cache = new NodeCache({ stdTTL: 60 }); // Cache for 1 minute instead of 10

// Add state abbreviation mapping
const stateMapping = {
    'US': 'United States',
    'AL': 'Alabama',
    'AK': 'Alaska',
    'AZ': 'Arizona',
    'AR': 'Arkansas',
    'CA': 'California',
    'CO': 'Colorado',
    'CT': 'Connecticut',
    'DE': 'Delaware',
    'FL': 'Florida',
    'GA': 'Georgia',
    'HI': 'Hawaii',
    'ID': 'Idaho',
    'IL': 'Illinois',
    'IN': 'Indiana',
    'IA': 'Iowa',
    'KS': 'Kansas',
    'KY': 'Kentucky',
    'LA': 'Louisiana',
    'ME': 'Maine',
    'MD': 'Maryland',
    'MA': 'Massachusetts',
    'MI': 'Michigan',
    'MN': 'Minnesota',
    'MS': 'Mississippi',
    'MO': 'Missouri',
    'MT': 'Montana',
    'NE': 'Nebraska',
    'NV': 'Nevada',
    'NH': 'New Hampshire',
    'NJ': 'New Jersey',
    'NM': 'New Mexico',
    'NY': 'New York',
    'NC': 'North Carolina',
    'ND': 'North Dakota',
    'OH': 'Ohio',
    'OK': 'Oklahoma',
    'OR': 'Oregon',
    'PA': 'Pennsylvania',
    'RI': 'Rhode Island',
    'SC': 'South Carolina',
    'SD': 'South Dakota',
    'TN': 'Tennessee',
    'TX': 'Texas',
    'UT': 'Utah',
    'VT': 'Vermont',
    'VA': 'Virginia',
    'WA': 'Washington',
    'WV': 'West Virginia',
    'WI': 'Wisconsin',
    'WY': 'Wyoming'
};

// Add reverse state mapping (full name to abbreviation)
const reverseStateMapping = Object.entries(stateMapping).reduce((acc, [abbr, full]) => {
    if (abbr !== 'US') {  // Skip the US mapping
        acc[full.toUpperCase()] = abbr;
    }
    return acc;
}, {});

// Basic route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// API Routes
app.get('/api/cities', (req, res) => {
    const cities = [...new Set(cityCenters.map(location => location.Cities))].sort();
    res.json(cities);
});

app.get('/api/map-data', (req, res) => {
    const cacheKey = `map-data-${req.query.city}-${req.query.radius}-${req.query.initial}`;
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
        return res.json(cachedData);
    }
    
    const radius = parseFloat(req.query.radius) || 35;
    const city = req.query.city;
    const isInitialLoad = req.query.initial === 'true';

    console.log('Map data request:', { radius, city, isInitialLoad });

    // Always send all Walmart locations
    let filteredWalmarts = walmartLocations;
    
    // Filter city centers and LINAC locations based on city
    let filteredCityCenters = cityCenters;
    let filteredLinacs = linacLocations.filter(location => 
        location.Latitude && location.Longitude // Only include locations with valid coordinates
    );

    if (!isInitialLoad && city && city !== 'all') {
        filteredCityCenters = cityCenters.filter(location => location.Cities === city);
    }

    const validLinacs = linacLocations.filter(location => location.Latitude && location.Longitude);
    console.log(`Total valid LINAC locations: ${validLinacs.length}`);

    const result = {
        walmart: filteredWalmarts,
        cityCenter: filteredCityCenters,
        linac: filteredLinacs
    };
    
    cache.set(cacheKey, result);
    res.json(result);
});

app.get('/api/metrics', async (req, res) => {
    const stateAbbr = req.query.state;
    const radius = parseFloat(req.query.radius) || 35;

    // Use walmartLocations for Walmart map pins
    const stateWalmarts = walmartLocations.filter(w => w.state === stateAbbr);

    // Use all LINAC locations with valid coordinates
    const validLinacs = linacLocations.filter(linac => 
        linac.Latitude && 
        linac.Longitude
    );

    console.log(`Found ${validLinacs.length} valid LINAC locations nationwide`);

    let walmartsOutsideCount = 0;

    for (const walmart of stateWalmarts) {
        if (!walmart.latitude || !walmart.longitude) {
            console.log(`Skipping Walmart (${walmart.name}) due to missing coordinates`);
            walmartsOutsideCount++;
            continue;
        }

        let isWithinRange = false;
        let shortestDistance = Infinity;

        for (const linac of validLinacs) {
            const distance = calculateDistance(
                parseFloat(walmart.latitude),
                parseFloat(walmart.longitude),
                parseFloat(linac.Latitude),
                parseFloat(linac.Longitude)
            );

            if (distance < shortestDistance) {
                shortestDistance = distance;
            }

            if (distance <= radius) {
                isWithinRange = true;
                break;
            }
        }

        console.log(`Walmart (${walmart.name}) shortest distance to any LINAC: ${shortestDistance} miles`);

        if (!isWithinRange) {
            console.log(`Walmart (${walmart.name}) is outside the ${radius} mile radius of any LINAC`);
            walmartsOutsideCount++;
        }
    }

    console.log(`Total Walmarts outside ${radius} mile radius: ${walmartsOutsideCount}`);

    const totalWalmarts = stateWalmarts.length;

    // Calculate LINAC Centers and Total LINACs in the state
    let totalCenters = 0;
    let totalLinacs = 0;

    const stateCenters = cityCenters.filter(center => center.States === stateAbbr);

    stateCenters.forEach(center => {
        totalCenters += parseInt(center['Number of LINAC Centers']) || 0;
        totalLinacs += parseInt(center['Number of LINACs']) || 0;
    });

    console.log(`Total LINAC Centers in ${stateAbbr}: ${totalCenters}`);
    console.log(`Total LINACs in ${stateAbbr}: ${totalLinacs}`);

    const metrics = {
        walmartsOutsideRange: walmartsOutsideCount,
        walmartsWithinRange: totalWalmarts - walmartsOutsideCount,
        cityCentersWithinRange: totalCenters,
        linacsWithinRange: totalLinacs,
        totalWalmarts: totalWalmarts
    };

    console.log('\nSENDING METRICS:');
    console.log(JSON.stringify(metrics, null, 2));
    
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Expires', '-1');
    res.set('Pragma', 'no-cache');
    
    res.json(metrics);
});

// Update the state boundary endpoint
app.get('/api/state-boundary/:state', async (req, res) => {
    console.log('[Backend] Received request for state boundary');
    console.log('[Backend] Request params:', req.params);
    
    try {
        const fullStateName = stateMapping[req.params.state] || req.params.state;
        console.log(`[Backend] Using full state name: ${fullStateName}`);

        const stateQuery = `${fullStateName}, United States`;
        // For US boundary, we want admin_level=2 to get the country boundary
        const nominatimUrl = req.params.state === 'US' 
            ? `https://nominatim.openstreetmap.org/search?q=United States&format=json&polygon_geojson=1&countrycodes=us&featuretype=country`
            : `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(stateQuery)}&format=json&polygon_geojson=1&countrycodes=us`;
        
        console.log(`[Backend] Making request to Nominatim URL: ${nominatimUrl}`);

        const response = await axios.get(nominatimUrl, {
            headers: {
                'User-Agent': 'LINAC-App/1.0',
                'Accept': 'application/json'
            }
        });

        const nominatimData = response.data;
        
        if (!nominatimData || nominatimData.length === 0) {
            console.log('[Backend] No results from Nominatim');
            return res.status(404).json({ error: 'Boundary not found' });
        }

        // Find the appropriate boundary
        const boundaryData = req.params.state === 'US'
            ? nominatimData.find(item => item.class === 'boundary' && item.type === 'administrative' && item.geojson)
            : nominatimData.find(item => 
                item.osm_type === 'relation' && 
                item.class === 'boundary' && 
                item.type === 'administrative' &&
                item.geojson
            );

        if (!boundaryData || !boundaryData.geojson) {
            console.log('[Backend] No matching boundary found');
            return res.status(404).json({ error: 'Boundary not found' });
        }

        res.json([{ geojson: boundaryData.geojson }]);
    } catch (error) {
        console.error('[Backend] Error fetching boundary:', error);
        res.status(500).json({ error: 'Failed to fetch boundary' });
    }
});

// Add this new endpoint for states
app.get('/api/states', (req, res) => {
    // Get unique states from Walmart locations
    const states = [...new Set(walmartLocations.map(location => location.state))].sort();
    res.json(states);
});

// Function to calculate distance between two coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Radius of the Earth in miles
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Start with initial port
tryPort(4000);