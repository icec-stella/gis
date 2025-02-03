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

const app = express();
const PORT = process.env.PORT || 5002;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Add caching for API responses
const cache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

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
    
    if (!stateAbbr) {
        return res.status(400).json({ error: 'State parameter is required' });
    }

    try {
        if (stateAbbr === 'US') {
            // Calculate nationwide totals
            const totalCenters = cityCenters.reduce((sum, center) => 
                sum + (parseInt(center['Number of LINAC Centers']) || 0), 0);
            const totalLinacs = cityCenters.reduce((sum, center) => 
                sum + (parseInt(center['Number of LINACs']) || 0), 0);

            // Calculate Walmarts not within range of any LINAC
            const walmartsOutsideRange = walmartLocations.filter(walmart => {
                if (!walmart.latitude || !walmart.longitude) return true;

                const isNearLinac = linacLocations.some(linac => {
                    if (!linac.Latitude || !linac.Longitude) return false;
                    
                    const distance = calculateDistance(
                        parseFloat(walmart.latitude),
                        parseFloat(walmart.longitude),
                        parseFloat(linac.Latitude),
                        parseFloat(linac.Longitude)
                    );
                    return distance <= 35;
                });
                return !isNearLinac;
            }).length;

            return res.json({
                walmartsOutsideRange,
                walmartsWithinRange: walmartLocations.length,
                cityCentersWithinRange: totalCenters,
                linacsWithinRange: totalLinacs
            });
        }

        // Get full state name
        const fullStateName = stateMapping[stateAbbr];

        // Filter locations by state
        const stateWalmarts = walmartLocations.filter(location => location.state === stateAbbr);
        
        // Get LINAC centers from city-centers.json for the state
        const stateCenters = cityCenters.filter(center => 
            center.States === stateAbbr && 
            center['Number of LINAC Centers'] && 
            center['Number of LINACs']
        );

        // Calculate total centers and LINACs for the state
        const totalCenters = stateCenters.reduce((sum, center) => 
            sum + (parseInt(center['Number of LINAC Centers']) || 0), 0);
        const totalLinacs = stateCenters.reduce((sum, center) => 
            sum + (parseInt(center['Number of LINACs']) || 0), 0);

        // Get LINAC locations for distance calculations
        const stateLinacs = linacLocations.filter(location => {
            const hasValidCoords = location.Latitude && 
                                 location.Longitude && 
                                 !isNaN(location.Latitude) && 
                                 !isNaN(location.Longitude);
            
            // Use coordinates to determine if the LINAC is in the state
            if (!hasValidCoords) return false;

            // Check if any city center in the state matches these coordinates
            return stateCenters.some(center => 
                Math.abs(parseFloat(center.Latitude) - parseFloat(location.Latitude)) < 0.01 &&
                Math.abs(parseFloat(center.Longtitude) - parseFloat(location.Longitude)) < 0.01
            );
        });

        // Calculate Walmarts not within range of any LINAC
        const walmartsOutsideRange = stateWalmarts.filter(walmart => {
            if (!walmart.latitude || !walmart.longitude) return true;

            const isNearLinac = stateLinacs.some(linac => {
                if (!linac.Latitude || !linac.Longitude) return false;
                
                const distance = calculateDistance(
                    parseFloat(walmart.latitude),
                    parseFloat(walmart.longitude),
                    parseFloat(linac.Latitude),
                    parseFloat(linac.Longitude)
                );
                return distance <= 35;
            });
            return !isNearLinac;
        }).length;

        const metrics = {
            walmartsOutsideRange,
            walmartsWithinRange: stateWalmarts.length,
            cityCentersWithinRange: totalCenters,
            linacsWithinRange: totalLinacs
        };

        console.log('Metrics for', stateAbbr, ':', metrics);
        res.json(metrics);
    } catch (error) {
        console.error('Error calculating state metrics:', error);
        res.status(500).json({ error: 'Failed to calculate metrics' });
    }
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

// Add more logging to the distance calculation
function calculateDistance(lat1, lon1, lat2, lon2) {
    // Add input validation with detailed logging
    if (!lat1 || !lon1 || !lat2 || !lon2) {
        console.log('Invalid coordinates in calculateDistance:', { lat1, lon1, lat2, lon2 });
        return Infinity;
    }

    const R = 3959; // Earth's radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    return distance;
}

function toRad(degrees) {
    return degrees * (Math.PI/180);
}

// Start server with error handling
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is busy. Please try a different port.`);
    }
});