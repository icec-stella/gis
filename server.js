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

app.get('/api/metrics', (req, res) => {
    const city = req.query.city;
    const radius = parseFloat(req.query.radius) || 35;
    
    const selectedCenter = cityCenters.find(location => location.Cities === city);
    
    if (selectedCenter) {
        let walmartsWithinRange = 0;
        let walmartsOutsideRange = 0;
        let distances = [];  // Store all distances for calculations
        let stateWalmarts = 0;  // Count Walmarts in same state
        
        // Calculate distances and counts
        walmartLocations.forEach((walmart) => {
            if (!walmart.latitude || !walmart.longitude) return;

            const distance = calculateDistance(
                parseFloat(walmart.latitude),
                parseFloat(walmart.longitude),
                parseFloat(selectedCenter.Latitude),
                parseFloat(selectedCenter.Longtitude)
            );
            
            // Store distance for calculations
            distances.push({
                distance: distance,
                walmart: walmart
            });

            // Count Walmarts in same state
            if (walmart.state === selectedCenter.States) {
                stateWalmarts++;
            }

            if (distance <= radius) {
                walmartsWithinRange++;
            } else {
                walmartsOutsideRange++;
            }
        });

        // Sort distances for calculations
        distances.sort((a, b) => a.distance - b.distance);

        const metrics = {
            // Original metrics
            walmartsOutsideRange,
            walmartsWithinRange,
            cityCentersWithinRange: selectedCenter['Number of LINAC Centers'],
            linacsWithinRange: selectedCenter['Number of LINACs'],
            
            // Distance metrics
            nearestWalmart: distances[0]?.distance.toFixed(1) || 0,
            furthestWalmart: distances[distances.length - 1]?.distance.toFixed(1) || 0,
            averageDistance: (distances.reduce((sum, d) => sum + d.distance, 0) / distances.length).toFixed(1),
            
            // Coverage metrics
            walmartCoveragePercent: ((walmartsWithinRange / stateWalmarts) * 100).toFixed(1),
            walmartDensity: (walmartsWithinRange / (Math.PI * Math.pow(radius, 2))).toFixed(2),
            
            // Range breakdown
            within5Miles: distances.filter(d => d.distance <= 5).length,
            within15Miles: distances.filter(d => d.distance <= 15).length,
            within25Miles: distances.filter(d => d.distance <= 25).length,
            
            // State metrics
            totalStateWalmarts: stateWalmarts,
            stateCoveragePercent: ((walmartsWithinRange / stateWalmarts) * 100).toFixed(1)
        };
        
        res.json(metrics);
    } else {
        res.json({
            // Include all metrics with zero/null values
            walmartsOutsideRange: 0,
            walmartsWithinRange: 0,
            cityCentersWithinRange: 0,
            linacsWithinRange: 0,
            nearestWalmart: 0,
            furthestWalmart: 0,
            averageDistance: 0,
            walmartCoveragePercent: 0,
            walmartDensity: 0,
            within5Miles: 0,
            within15Miles: 0,
            within25Miles: 0,
            totalStateWalmarts: 0,
            stateCoveragePercent: 0
        });
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
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(stateQuery)}&format=json&polygon_geojson=1&countrycodes=us`;
        
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
            return res.status(404).json({ error: 'State boundary not found' });
        }

        // Find the state-level result
        const stateData = nominatimData.find(item => 
            item.osm_type === 'relation' && 
            item.class === 'boundary' && 
            item.type === 'administrative' &&
            item.geojson
        );

        if (!stateData || !stateData.geojson) {
            console.log('[Backend] No matching state boundary found');
            return res.status(404).json({ error: 'State boundary not found' });
        }

        // Send just the array containing the state data
        res.json([{ geojson: stateData.geojson }]);
    } catch (error) {
        console.error('[Backend] Error fetching state boundary:', error);
        res.status(500).json({ error: 'Failed to fetch state boundary' });
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