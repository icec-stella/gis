const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const https = require('https');
const axios = require('axios');
const fs = require('fs');

// Minimal startup logging
console.log('\n=== LINAC Analysis Server ===');

const app = express();

// Start with a new port number
const NEW_PORT = 5025;

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

// Helper function to load data fresh from files
function loadDataFromFile(filePath) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Error loading data from ${filePath}:`, error);
        return [];
    }
}

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
    const cityCenters = loadDataFromFile('./src/data/city-centers.json');
    const cities = [...new Set(cityCenters.map(location => location.Cities))].sort();
    res.json(cities);
});

app.get('/api/map-data', (req, res) => {
    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const cityCenters = loadDataFromFile('./src/data/city-centers.json');
    const linacLocations = loadDataFromFile('./src/data/linac-locations.json');
    
    console.log(`[Server] Loading fresh data: ${walmartLocations.length} Walmarts, ${linacLocations.length} LINACs`);
    console.log(`[Server] First LINAC entry: ${JSON.stringify(linacLocations[0]).substring(0, 200)}`);
    console.log(`[Server] Last LINAC entry: ${JSON.stringify(linacLocations[linacLocations.length-1]).substring(0, 200)}`);
    
    const radius = parseFloat(req.query.radius) || 35;
    const city = req.query.city;
    const isInitialLoad = req.query.initial === 'true';

    // Always send all Walmart locations
    let filteredWalmarts = walmartLocations;
    
    // Filter city centers and LINAC locations based on city
    let filteredCityCenters = cityCenters;
    let filteredLinacs = linacLocations.filter(location => 
        location.Latitude && location.Longitude
    );

    if (!isInitialLoad && city && city !== 'all') {
        filteredCityCenters = cityCenters.filter(location => location.Cities === city);
    }

    const result = {
        walmart: filteredWalmarts,
        cityCenter: filteredCityCenters,
        linac: filteredLinacs
    };
    
    res.json(result);
});

app.get('/api/metrics', async (req, res) => {
    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    const linacLocations = loadDataFromFile('./src/data/linac-locations.json');
    
    console.log(`[Server] Metrics API - Loading data: ${walmartLocations.length} Walmarts, ${linacLocations.length} LINACs`);
    
    const stateAbbr = req.query.state;
    const radius = parseFloat(req.query.radius) || 35;
    const stateWalmarts = walmartLocations.filter(w => w.state === stateAbbr);
    const validLinacs = linacLocations.filter(linac => linac.Latitude && linac.Longitude);
    
    console.log(`[Server] Calculating metrics for state ${stateAbbr} with radius ${radius} miles`);
    console.log(`[Server] State has ${stateWalmarts.length} Walmart locations and there are ${validLinacs.length} valid LINAC centers`);
    
    let walmartsOutsideCount = 0;
    let walmartsWithinCount = 0;
    let walmartsInvalidCount = 0;

    for (const walmart of stateWalmarts) {
        if (!walmart.latitude || !walmart.longitude) {
            walmartsOutsideCount++;
            walmartsInvalidCount++;
            continue;
        }

        let isWithinRange = false;
        for (const linac of validLinacs) {
            const distance = calculateDistance(
                parseFloat(walmart.latitude),
                parseFloat(walmart.longitude),
                parseFloat(linac.Latitude),
                parseFloat(linac.Longitude)
            );

            if (distance <= radius) {
                isWithinRange = true;
                break;
            }
        }

        if (!isWithinRange) {
            walmartsOutsideCount++;
        } else {
            walmartsWithinCount++;
        }
    }

    const totalWalmarts = stateWalmarts.length;
    const stateLinacs = linacLocations.filter(center => center.States === stateAbbr);
    const totalCenters = stateLinacs.length; // Each object represents one center
    let totalLinacs = 0;
    stateLinacs.forEach(center => {
        totalLinacs += parseInt(center['Number of LINACs']) || 0;
    });
    
    console.log(`[Server] Metrics results: ${walmartsOutsideCount} Walmarts outside range, ${walmartsWithinCount} within range, ${walmartsInvalidCount} invalid coordinates`);
    console.log(`[Server] State ${stateAbbr} has ${totalCenters} LINAC centers with ${totalLinacs} total LINACs`);

    res.json({
        walmartsOutsideRange: walmartsOutsideCount,
        totalWalmarts: totalWalmarts,
        cityCentersWithinRange: totalCenters, // This is a legacy field name
        linacsWithinRange: totalLinacs
    });
});

app.get('/api/states', (req, res) => {
    const walmartLocations = loadDataFromFile('./src/data/walmart-locations.json');
    
    // Get unique states from Walmart data
    const statesFromData = [...new Set(walmartLocations.map(location => location.state))];
    
    // Sort states alphabetically
    const sortedStates = statesFromData.sort();
    
    // Return the sorted list of states
    res.json(sortedStates);
});

app.get('/api/state-boundary/:state', async (req, res) => {
    // Dynamic data loading
    const state = req.params.state;
    let stateName = stateMapping[state] || state;
    
    try {
        // Special case for US
        if (state === 'US') {
            stateName = 'United States';
            const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=United States&format=json&polygon_geojson=1&countrycodes=us&featuretype=country`;
            
            const response = await axios.get(nominatimUrl, {
                headers: {
                    'User-Agent': 'LINAC-App/1.0',
                    'Accept': 'application/json'
                }
            });
            
            const nominatimData = response.data;
            
            if (!nominatimData || nominatimData.length === 0) {
                return res.status(404).json({ error: 'US Boundary not found' });
            }
            
            const boundaryData = nominatimData.find(item => 
                item.class === 'boundary' && 
                item.type === 'administrative' && 
                item.geojson
            );
            
            if (!boundaryData || !boundaryData.geojson) {
                return res.status(404).json({ error: 'US Boundary not found' });
            }
            
            return res.json([{ geojson: boundaryData.geojson }]);
        }
        
        // For individual states, use Nominatim instead of Overpass for more reliable results
        const fullStateName = stateName;
        const stateQuery = `${fullStateName}, United States`;
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(stateQuery)}&format=json&polygon_geojson=1&countrycodes=us`;
        
        console.log(`[Server] Fetching boundary for state: ${state} (${fullStateName})`);
        
        const response = await axios.get(nominatimUrl, {
            headers: {
                'User-Agent': 'LINAC-App/1.0',
                'Accept': 'application/json'
            }
        });
        
        const nominatimData = response.data;
        
        if (!nominatimData || nominatimData.length === 0) {
            console.error(`[Server] No boundary found for state: ${state}`);
            return res.status(404).json({ error: 'Boundary not found' });
        }
        
        // Find the administrative boundary for the state
        const boundaryData = nominatimData.find(item => 
            item.class === 'boundary' && 
            item.type === 'administrative' &&
            item.geojson
        );
        
        if (!boundaryData || !boundaryData.geojson) {
            console.error(`[Server] No valid boundary data found for state: ${state}`);
            return res.status(404).json({ error: 'Boundary not found' });
        }
        
        return res.json([{ geojson: boundaryData.geojson }]);
    } catch (error) {
        console.error('Error fetching state boundary:', error);
        res.status(500).json({ error: 'Failed to fetch state boundary' });
    }
});

// Start the server
tryPort(NEW_PORT);

// Helper function for distance calculation
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) {
        return Number.MAX_VALUE;
    }
    
    // Convert latitude and longitude from degrees to radians
    const radLat1 = (Math.PI * lat1) / 180;
    const radLon1 = (Math.PI * lon1) / 180;
    const radLat2 = (Math.PI * lat2) / 180;
    const radLon2 = (Math.PI * lon2) / 180;
    
    // Haversine formula
    const dLat = radLat2 - radLat1;
    const dLon = radLon2 - radLon1;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(radLat1) * Math.cos(radLat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    // Radius of the Earth in miles
    const R = 3958.8; // miles
    
    // Calculate the distance
    return R * c;
}