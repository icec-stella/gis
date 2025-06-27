// Global variables
let map;
let walmartMarkers = [];
let linacMarkers = [];
let radiusCircles = [];
let stateLayer;
let selectedLocationCircle = null;
let usBoundaryLayer;
let legendControl; // Add global reference to legend control
let walmartsHidden = false; // Track if Walmarts are being hidden

const blueMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-blue.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

const redMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-red.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

// Add state code to name mapping
const stateNames = {
    'AL': 'Alabama',
    'AK': 'Alaska',
    'AZ': 'Arizona',
    'AR': 'Arkansas',
    'CA': 'California',
    'CO': 'Colorado',
    'CT': 'Connecticut',
    'DC': 'District of Columbia',
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
    'WY': 'Wyoming',
    'US': 'United States'
};

// Initialize the map
async function initializeMap() {
    // Check if the map is already initialized
    if (map) {
        // console.warn('Map is already initialized.');
        return;
    }

    try {
        map = L.map('map', {
            preferCanvas: true,
            wheelDebounceTime: 150,
            wheelPxPerZoomLevel: 120,
            zoomSnap: 0.5,
            zoomDelta: 0.5,
        }).setView([39.8283, -98.5795], 4);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);

        // Add legend
        legendControl = L.control({ position: 'bottomleft' });
        legendControl.onAdd = function(map) {
            const div = L.DomUtil.create('div', 'legend');
            div.innerHTML = getLegendHTML();
            return div;
        };
        legendControl.addTo(map);

        // Load US boundary and wait for it to complete
        const response = await fetch('/api/state-boundary/US');
        if (!response.ok) {
            throw new Error('Failed to load US boundary');
        }
        const data = await response.json();
        usBoundaryLayer = L.geoJSON(data[0].geojson, {
            style: {
                color: '#0d6efd',
                weight: 2,
                fillOpacity: 0.05
            }
        }).addTo(map);

        // Only load markers after boundary is loaded
        await loadInitialMarkers();
    } catch (error) {
        console.error('Error initializing map:', error);
        hideLoadingOverlay();
    }
}

// Add helper function to validate coordinates
function isValidUSCoordinate(lat, lng) {
    // Rough bounding box for continental US, Alaska, and Hawaii
    const bounds = {
        continental: {
            lat: { min: 24.396308, max: 49.384358 },
            lng: { min: -125.000000, max: -66.934570 }
        },
        alaska: {
            lat: { min: 51.214183, max: 71.365162 },
            lng: { min: -179.148909, max: -130.001476 }
        },
        hawaii: {
            lat: { min: 18.910361, max: 22.236428 },
            lng: { min: -160.236328, max: -154.808349 }
        }
    };

    // Check if coordinates are within any of the US regions
    return (
        // Continental US
        (lat >= bounds.continental.lat.min && lat <= bounds.continental.lat.max &&
         lng >= bounds.continental.lng.min && lng <= bounds.continental.lng.max) ||
        // Alaska
        (lat >= bounds.alaska.lat.min && lat <= bounds.alaska.lat.max &&
         lng >= bounds.alaska.lng.min && lng <= bounds.alaska.lng.max) ||
        // Hawaii
        (lat >= bounds.hawaii.lat.min && lat <= bounds.hawaii.lat.max &&
         lng >= bounds.hawaii.lng.min && lng <= bounds.hawaii.lng.max)
    );
}

// Helper function to create a cacheBusting URL
function createCacheBustingUrl(url) {
    const cacheBuster = Date.now();
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_=${cacheBuster}`;
}

// Update all fetch calls to use cacheBusting
async function fetchWithCacheBusting(url, options = {}) {
    const cacheBustingUrl = createCacheBustingUrl(url);
    const response = await fetch(cacheBustingUrl, {
        ...options,
        headers: {
            ...options.headers,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

// Update loadInitialMarkers function
async function loadInitialMarkers() {
    try {
        const response = await fetchWithCacheBusting('/api/map-data?initial=true');
        const data = response;
        
        clearMap();
        
        // Create a counter for loaded markers
        let loadedMarkers = 0;
        const totalMarkers = data.walmart.length + data.linac.length;
        
        // Add Walmart markers
        data.walmart.forEach(location => {
            if (!location.latitude || !location.longitude) {
                loadedMarkers++;
                checkLoadingComplete(loadedMarkers, totalMarkers);
                return;
            }

            const latLng = L.latLng(location.latitude, location.longitude);
            
            // Only add marker if within US bounds
            if (usBoundaryLayer && usBoundaryLayer.getBounds().contains(latLng)) {
                const marker = L.marker(latLng, {
                    icon: blueMarkerIcon
                }).addTo(map);
                
                marker.bindPopup(`
                    <strong>Walmart</strong><br>
                    ${location.name}<br>
                    ${location.street_address}<br>
                    ${location.city}, ${location.state}
                `);
                
                walmartMarkers.push(marker);
            }
            loadedMarkers++;
            checkLoadingComplete(loadedMarkers, totalMarkers);
        });

        // Count LINAC entries with missing coordinates
        const missingCoordinates = data.linac.filter(location => 
            !location.Latitude || !location.Longitude || 
            isNaN(location.Latitude) || isNaN(location.Longitude)
        ).length;

        // Count LINAC entries outside US bounds
        const outsideUSBounds = data.linac.filter(location => {
            if (!location.Latitude || !location.Longitude || 
                isNaN(location.Latitude) || isNaN(location.Longitude)) {
                return false;
            }
            return !isValidUSCoordinate(parseFloat(location.Latitude), parseFloat(location.Longitude));
        }).length;

        // Add LINAC markers
        data.linac.forEach(location => {
            if (!location.Latitude || !location.Longitude || 
                isNaN(location.Latitude) || isNaN(location.Longitude)) {
                loadedMarkers++;
                checkLoadingComplete(loadedMarkers, totalMarkers);
                return;
            }

            const latLng = L.latLng(location.Latitude, location.Longitude);
            
            if (isValidUSCoordinate(parseFloat(location.Latitude), parseFloat(location.Longitude)) &&
                (!usBoundaryLayer || usBoundaryLayer.getBounds().contains(latLng))) {
                const marker = L.marker(latLng, {
                    icon: redMarkerIcon
                }).addTo(map);
                
                // Store the original LINAC data with the marker for side nav access
                marker.linacData = location;
                
                marker.bindPopup(`
                    <strong>LINAC Center</strong><br>
                    ${location['LINAC Name']}
                `);
                
                // Add click event handler for LINAC markers
                marker.on('click', function() {
                    const radius = document.getElementById('radius').value;
                    
                    // Remove existing circle if any
                    if (selectedLocationCircle) {
                        map.removeLayer(selectedLocationCircle);
                    }
                    
                    // Calculate appropriate zoom level based on radius
                    const zoomLevel = calculateZoomLevel(radius * 1609.34);
                    
                    // Create new circle for the LINAC
                    selectedLocationCircle = L.circle(latLng, {
                        radius: radius * 1609.34, // Convert miles to meters
                        color: 'red',
                        fillColor: '#f03',
                        fillOpacity: 0.1
                    }).addTo(map);
                    
                    // Create a bounds object centered on the location
                    const bounds = selectedLocationCircle.getBounds();
                    
                    // Fit the map to these bounds and force the zoom level
                    map.fitBounds(bounds, {
                        animate: true,
                        duration: 0.3,
                        maxZoom: zoomLevel,
                        padding: [50, 50] // Add some padding around the circle
                    });
                });
                
                linacMarkers.push(marker);
            }
            loadedMarkers++;
            checkLoadingComplete(loadedMarkers, totalMarkers);
        });

        console.log(`Total LINAC Centers displayed on map (red markers): ${linacMarkers.length}`);
        console.log(`LINAC entries with missing/invalid coordinates: ${missingCoordinates}`);
        console.log(`LINAC entries with coordinates outside US bounds: ${outsideUSBounds}`);
    } catch (error) {
        console.error('Error loading initial markers:', error);
        hideLoadingOverlay();
    }
}

// Update checkLoadingComplete function
function checkLoadingComplete(loaded, total) {
    // console.log(`Loading progress: ${loaded}/${total}`);
    if (loaded >= total) {
        // console.log('Loading complete, hiding overlay');
        hideLoadingOverlay();
    }
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('fade-out');
    // Remove the overlay from DOM after fade animation
    setTimeout(() => {
        overlay.remove();
    }, 300);
}

// Initialize event listeners
function initializeEventListeners() {
    const radiusSlider = document.getElementById('radius');
    const radiusValue = document.getElementById('radius-value');
    const stateSelect = document.getElementById('state');
    const analyzeButton = document.getElementById('analyze');

    radiusSlider.addEventListener('input', async (e) => {
        const radius = e.target.value;
        radiusValue.textContent = radius;
        console.log(`[Frontend] Radius changed to: ${radius}`);
        
        // Update circle radius if one exists
        if (selectedLocationCircle) {
            selectedLocationCircle.setRadius(radius * 1609.34);
        }
        
        // Update legend with new radius only if Walmarts are hidden
        if (walmartsHidden) {
            updateLegend();
        }
        
        // Update metrics when radius changes
        if (stateSelect.value && stateSelect.value !== 'all') {
            const selectedState = stateSelect.value;
            
            try {
                console.log(`[Frontend] Fetching metrics for state: ${selectedState}, radius: ${radius}`);
                const response = await fetch(`/api/metrics?state=${selectedState}&radius=${radius}`);
                const metrics = await response.json();
                console.log('[Frontend] Received metrics:', metrics);
                
                // Update the metrics display if modal is open
                if (!document.getElementById('dashboard-modal').classList.contains('d-none')) {
                    const metricsHTML = `
                        <div class="metric-card">
                            <div class="metric-value">${metrics.walmartsOutsideRange || 0}</div>
                            <div class="metric-label">Walmarts Not Within ${radius} Miles of LINAC</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value">${metrics.totalWalmarts || 0}</div>
                            <div class="metric-label">Total Walmarts in State</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value">${metrics.cityCentersWithinRange || 0}</div>
                            <div class="metric-label">LINAC Centers in State</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value">${metrics.linacsWithinRange || 0}</div>
                            <div class="metric-label">Total LINACs in State</div>
                        </div>
                    `;
                    
                    document.getElementById('modal-dashboard-metrics').innerHTML = metricsHTML;
                }
                
                // If table view is active, update it as well
                if (document.getElementById('metrics-table-body')) {
                    createMetricsTable();
                }
            } catch (error) {
                console.error('Error updating metrics:', error);
            }
        }
    });

    // Only update analysis when analyze button is clicked
    analyzeButton.addEventListener('click', updateAnalysis);
    
    // Remove automatic updates on slider and city changes
    // radiusSlider.addEventListener('change', updateAnalysis);
    // citySelect.addEventListener('change', updateAnalysis);

    // Add toggle button listeners
    document.getElementById('walmart-toggle').addEventListener('change', updateLocationList);
    document.getElementById('linac-toggle').addEventListener('change', updateLocationList);

    // Update dashboard button click handler
    document.getElementById('dashboard-button').addEventListener('click', async () => {
        const selectedState = document.getElementById('state').value;
        const radius = document.getElementById('radius').value;
        
        // Reset the modal content back to the dashboard view
        const modalContent = document.getElementById('dashboard-modal');
        modalContent.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="dashboard-title">Dashboard</h5>
                    <button type="button" class="btn-close" id="close-modal"></button>
                </div>
                <div class="modal-body">
                    <div id="modal-dashboard-metrics" class="dashboard-grid"></div>
                </div>
            </div>
        `;

        // Reattach close button listener
        document.getElementById('close-modal').addEventListener('click', () => {
            document.getElementById('modal-overlay').classList.add('d-none');
            document.getElementById('dashboard-modal').classList.add('d-none');
        });

        const dashboardTitle = document.getElementById('dashboard-title');
        // Update title with selected state
        if (selectedState && selectedState !== 'all') {
            dashboardTitle.textContent = `Dashboard - ${stateNames[selectedState] || selectedState}`;
        } else {
            dashboardTitle.textContent = 'Dashboard';
        }

        // Show loading state in modal
        document.getElementById('modal-dashboard-metrics').innerHTML = `
            <div class="text-center">
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
            </div>
        `;
        
        // Show the modal
        document.getElementById('modal-overlay').classList.remove('d-none');
        document.getElementById('dashboard-modal').classList.remove('d-none');

        // Fetch and display metrics for the current state
        try {
            const response = await fetch(`/api/metrics?state=${selectedState}&radius=${radius}`);
            const metrics = await response.json();
            
            const metricsHTML = `
                <div class="metric-card">
                    <div class="metric-value">${metrics.walmartsOutsideRange || 0}</div>
                    <div class="metric-label">Walmarts Not Within ${radius} Miles of LINAC</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${metrics.totalWalmarts || 0}</div>
                    <div class="metric-label">Total Walmarts in State</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${metrics.cityCentersWithinRange || 0}</div>
                    <div class="metric-label">LINAC Centers in State</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${metrics.linacsWithinRange || 0}</div>
                    <div class="metric-label">Total LINACs in State</div>
                </div>
            `;

            document.getElementById('modal-dashboard-metrics').innerHTML = metricsHTML;
        } catch (error) {
            console.error('Error fetching metrics:', error);
            document.getElementById('modal-dashboard-metrics').innerHTML = `
                <div class="alert alert-danger">
                    Error loading metrics. Please try again later.
                </div>
            `;
        }
    });

    document.getElementById('close-modal').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('d-none');
        document.getElementById('dashboard-modal').classList.add('d-none');
    });

    // Close modal when clicking overlay
    document.getElementById('modal-overlay').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('d-none');
        document.getElementById('dashboard-modal').classList.add('d-none');
    });

    // Update toggle Walmarts button listener
    const toggleWalmartsBtn = document.getElementById('toggle-walmarts');
    console.log('Toggle button found:', toggleWalmartsBtn); // Check if button exists
    console.log('Toggle button text:', toggleWalmartsBtn?.textContent); // Check initial text

    toggleWalmartsBtn.addEventListener('click', () => {
        console.log('Toggle button clicked!'); // Log when clicked
        const isHiding = toggleWalmartsBtn.textContent === 'Hide Walmarts';
        console.log('isHiding:', isHiding); // Log the state
        const selectedState = document.getElementById('state').value;
        console.log('selectedState:', selectedState); // Log selected state
        
        // Allow toggling for US view or when a specific state is selected
        if (selectedState === 'US' || (selectedState && selectedState !== 'all')) {
            console.log('Condition met, proceeding with toggle'); // Log if condition is met
            if (isHiding) {
                hideWalmartsNearLinac();
                toggleWalmartsBtn.textContent = 'Show All Walmarts';
                walmartsHidden = true; // Set state to hidden
            } else {
                showAllWalmarts();
                toggleWalmartsBtn.textContent = 'Hide Walmarts';
                walmartsHidden = false; // Set state to shown
            }
            // Update legend to reflect the new state
            updateLegend();
        } else {
            console.log('Toggle condition not met'); // Log if condition fails
        }
    });

    // Add table view button listener
    document.getElementById('table-view-button').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.remove('d-none');
        document.getElementById('dashboard-modal').classList.remove('d-none');
        createMetricsTable();
    });
}

// Update clearMap function
function clearMap() {
    walmartMarkers.forEach(marker => marker.remove());
    linacMarkers.forEach(marker => marker.remove());
    walmartMarkers = [];
    linacMarkers = [];
    radiusCircles.forEach(circle => circle.remove());
    radiusCircles = [];
}

// Update map markers
function updateMapMarkers(data) {
    radiusCircles.forEach(circle => circle.remove());
    radiusCircles = [];
    
    const radius = document.getElementById('radius').value;
    const selectedCity = document.getElementById('city').value;

    // Add radius circle for selected city
    if (selectedCity && selectedCity !== 'all' && data.cityCenter.length > 0) {
        const selectedLocation = data.cityCenter[0];
        
        console.log('Selected city center:', selectedLocation);

        if (!selectedLocation.Latitude || !selectedLocation.Longtitude) {
            console.error('Invalid city center coordinates:', selectedLocation);
            return;
        }

        const circle = L.circle([
            parseFloat(selectedLocation.Latitude), 
            parseFloat(selectedLocation.Longtitude)
        ], {
            radius: radius * 1609.34,
            color: 'red',
            fillColor: '#f03',
            fillOpacity: 0.1
        }).addTo(map);
        radiusCircles.push(circle);

        const zoom = calculateZoomLevel(radius * 1609.34);
        map.setView([
            parseFloat(selectedLocation.Latitude), 
            parseFloat(selectedLocation.Longtitude)
        ], zoom);
    }
}

// Helper function to calculate appropriate zoom level
function calculateZoomLevel(radiusInMeters) {
    // These are approximate zoom levels that work well with different radius sizes
    if (radiusInMeters > 80000) return 8;      // 50+ miles
    if (radiusInMeters > 48000) return 9;      // 30-50 miles
    if (radiusInMeters > 32000) return 9;      // 20-30 miles
    if (radiusInMeters > 16000) return 10;     // 10-20 miles
    return 10;                                 // < 10 miles
}

// Update displayMetrics function to include the radius in the label
function displayMetrics(metrics) {
    // Don't do anything if we're in table view
    const tableViewActive = document.getElementById('metrics-table-body') !== null;
    if (tableViewActive) {
        return;
    }

    // Only update the modal metrics
    const modalMetricsContainer = document.getElementById('modal-dashboard-metrics');
    if (!modalMetricsContainer) {
        return;
    }
    
    if (metrics) {
        const radius = document.getElementById('radius').value;
        const metricsHTML = `
            <div class="metric-card">
                <div class="metric-value">${metrics.walmartsOutsideRange || 0}</div>
                <div class="metric-label">Walmarts Not Within ${radius} Miles of LINAC</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">${metrics.totalWalmarts || 0}</div>
                <div class="metric-label">Total Walmarts in State</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">${metrics.cityCentersWithinRange || 0}</div>
                <div class="metric-label">LINAC Centers in State</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">${metrics.linacsWithinRange || 0}</div>
                <div class="metric-label">Total LINACs in State</div>
            </div>
        `;

        modalMetricsContainer.innerHTML = metricsHTML;
    } else {
        modalMetricsContainer.innerHTML = '';
    }
}

// Fetch and populate cities dropdown
async function populateCityDropdown() {
    try {
        const response = await fetch('/api/cities');
        const cities = await response.json();
        
        const citySelect = document.getElementById('city');
        cities.forEach(city => {
            const option = document.createElement('option');
            option.value = city;  // This is correct as it uses the Cities property from LINAC data
            option.textContent = city;
            citySelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading cities:', error);
    }
}

// Update dashboard metrics
async function updateDashboardMetrics() {
    try {
        const radius = document.getElementById('radius').value;
        const state = document.getElementById('state').value;
        
        const response = await fetch(`/api/metrics?state=${state}&radius=${radius}`);
        const metrics = await response.json();
        
        displayMetrics(metrics);
    } catch (error) {
        console.error('Error updating metrics:', error);
    }
}

// Update map data
async function updateMapData() {
    try {
        const radius = document.getElementById('radius').value;
        const city = document.getElementById('city').value;
        
        const response = await fetch(`/api/map-data?radius=${radius}&city=${city}`);
        const data = await response.json();
        
        updateMapMarkers(data);
    } catch (error) {
        console.error('Error updating map:', error);
    }
}

// Add these functions to handle loading states
function showLoading() {
    // Create and show the loading overlay
    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
        <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    `;
    document.body.appendChild(overlay);
}

// Update hideLoading function to include a smooth transition
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.add('fade-out');
        // Remove the overlay from DOM after fade animation
        setTimeout(() => {
            overlay.remove();
        }, 300);
    }
}

// Update populateStateDropdown to set initial US selection
async function populateStateDropdown() {
    try {
        const states = await fetchWithCacheBusting('/api/states');
        
        const stateSelect = document.getElementById('state');
        
        // Add the default "Select State" option
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Select State';
        defaultOption.disabled = true;
        stateSelect.insertBefore(defaultOption, stateSelect.firstChild);
        
        // Add US option
        const usOption = document.createElement('option');
        usOption.value = 'US';
        usOption.textContent = 'United States';
        stateSelect.insertBefore(usOption, stateSelect.firstChild);
        
        // Add all states with full names
        states.forEach(stateCode => {
            const option = document.createElement('option');
            option.value = stateCode;
            option.textContent = stateNames[stateCode] || stateCode; // Fallback to code if name not found
            stateSelect.appendChild(option);
        });

        // Set initial selection to US
        stateSelect.value = 'US';
        
        // Trigger an initial analysis for US view
        updateAnalysis();
    } catch (error) {
        console.error('Error loading states:', error);
    }
}

// Update loadStateBoundary function
async function loadStateBoundary(state) {
    try {
        // Clear existing state boundary
        if (stateLayer) {
            map.removeLayer(stateLayer);
            stateLayer = null;
        }

        const data = await fetchWithCacheBusting(`/api/state-boundary/${state}`);
        
        if (!data || !data[0] || !data[0].geojson) {
            throw new Error('Invalid GeoJSON data received');
        }

        stateLayer = L.geoJSON(data[0].geojson, {
            style: {
                color: '#0d6efd',
                weight: 2,
                fillOpacity: 0.1
            }
        }).addTo(map);
        
        // Special handling for Alaska
        if (state === 'AK') {
            // Custom bounds for Alaska that exclude far western Aleutian Islands
            const akBounds = L.latLngBounds(
                L.latLng(51.214183, -179.148909),
                L.latLng(71.365162, -130.001476)
            );
            map.fitBounds(akBounds, {
                padding: [50, 50],
                maxZoom: 5
            });
        } else {
            map.fitBounds(stateLayer.getBounds(), {
                padding: [50, 50]
            });
        }
        
        return true;
    } catch (error) {
        console.error('Error loading state boundary:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        return false;
    }
}

// Update updateAnalysis function to properly filter markers
async function updateAnalysis() {
    const state = document.getElementById('state').value;

    if (!state || state === 'all') {
        // console.log('No state selected');
        document.getElementById('location-list').classList.add('d-none');
        return;
    }

    try {
        showLoading();

        // Reset Walmarts visibility state when a new state is selected
        // This ensures the button text and legend match the actual map state
        walmartsHidden = false;
        const toggleWalmartsBtn = document.getElementById('toggle-walmarts');
        toggleWalmartsBtn.textContent = 'Hide Walmarts';
        updateLegend(); // Update legend to show "Walmart Locations"

        // Show the "Dashboard" button
        document.getElementById('dashboard-button').classList.remove('d-none');
        // Show the location list container
        document.getElementById('location-list').classList.remove('d-none');

        // Remove US boundary if it exists
        if (usBoundaryLayer) {
            map.removeLayer(usBoundaryLayer);
            usBoundaryLayer = null;
        }

        // Hide all markers first
        walmartMarkers.forEach(marker => {
            marker.setOpacity(0);
            marker.closePopup();
        });
        linacMarkers.forEach(marker => {
            marker.setOpacity(0);
            marker.closePopup();
        });

        if (state === 'US') {
            // Clear any existing state boundary
            if (stateLayer) {
                map.removeLayer(stateLayer);
                stateLayer = null;
            }
            
            // Show all markers for US view
            walmartMarkers.forEach(marker => marker.setOpacity(1));
            linacMarkers.forEach(marker => marker.setOpacity(1));
            
            // Set view to continental US
            map.setView([39.8283, -98.5795], 4);

            // Add back the US boundary for US view
            const response = await fetch('/api/state-boundary/US');
            if (response.ok) {
                const data = await response.json();
                usBoundaryLayer = L.geoJSON(data[0].geojson, {
                    style: {
                        color: '#0d6efd',
                        weight: 2,
                        fillOpacity: 0.05
                    }
                }).addTo(map);
            }

            // Get nationwide metrics from server
            const radius = document.getElementById('radius').value;
            const metricsResponse = await fetch(`/api/metrics?state=US&radius=${radius}`);
            const metrics = await metricsResponse.json();

            displayMetrics(metrics);
        } else {
            // Load state boundary and wait for result
            const boundaryLoaded = await loadStateBoundary(state);
            
            if (!boundaryLoaded || !stateLayer) {
                throw new Error('Failed to load state boundary');
            }

            // Show all markers, regardless of state boundaries
            walmartMarkers.forEach(marker => marker.setOpacity(1));
            linacMarkers.forEach(marker => marker.setOpacity(1));

            // Get state metrics from server
            const radius = document.getElementById('radius').value;
            const response = await fetch(`/api/metrics?state=${state}&radius=${radius}`);
            const metrics = await response.json();

            displayMetrics(metrics);
        }

        updateLocationList();
        hideLoading();
    } catch (error) {
        console.error('Error updating analysis:', error);
        hideLoading();
    }
}

// Add helper function to check if a point is inside a polygon
function isPointInPolygon(point, layer) {
    let inside = false;
    const lat = point.lat;
    const lng = point.lng;

    // Get all polygons from the layer
    layer.eachLayer(function(polygon) {
        if (polygon.feature && polygon.feature.geometry) {
            const coordinates = polygon.feature.geometry.coordinates;

            // Handle both Polygon and MultiPolygon
            if (polygon.feature.geometry.type === 'Polygon') {
                if (isPointInCoordinates(lat, lng, coordinates[0])) {
                    inside = true;
                }
            } else if (polygon.feature.geometry.type === 'MultiPolygon') {
                coordinates.forEach(poly => {
                    if (isPointInCoordinates(lat, lng, poly[0])) {
                        inside = true;
                    }
                });
            }
        }
    });

    return inside;
}

// Helper function for point-in-polygon calculation
function isPointInCoordinates(lat, lng, coords) {
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
        const xi = coords[i][0], yi = coords[i][1];
        const xj = coords[j][0], yj = coords[j][1];

        const intersect = ((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Update the location list function to only show visible Walmart markers
function updateLocationList() {
    const listContainer = document.getElementById('location-list');
    const showWalmart = document.getElementById('walmart-toggle').checked;
    const selectedState = document.getElementById('state').value;
    const radius = document.getElementById('radius').value;
    
    listContainer.innerHTML = '';
    let locationsFound = 0;
    
    if (showWalmart) {
        walmartMarkers.forEach(marker => {
            // For US view, show all markers, for state view, only show those within state boundaries
            let shouldShow = false;
            
            if (selectedState === 'US') {
                shouldShow = marker.options.opacity !== 0;
            } else if (stateLayer) {
                // Use proper point-in-polygon check instead of bounding box
                shouldShow = isPointInPolygon(marker.getLatLng(), stateLayer) && marker.options.opacity !== 0;
            }
            
            if (shouldShow) {
                const location = marker.getLatLng();
                const popup = marker.getPopup();
                const content = popup.getContent();
                
                const div = document.createElement('div');
                div.className = 'location-item';
                
                // For LINACs, create custom content that includes the Number of LINACs field
                if (marker.linacData) {
                    div.innerHTML = `
                        <strong>LINAC Center</strong><br>
                        ${marker.linacData['LINAC Name']}<br>
                        Number of LINACs: ${marker.linacData['Number of LINACs']}
                    `;
                } else {
                    div.innerHTML = content;
                }
                
                div.addEventListener('click', () => {
                    // Remove existing circle if any
                    if (selectedLocationCircle) {
                        map.removeLayer(selectedLocationCircle);
                    }
                    
                    // Calculate appropriate zoom level based on radius
                    const zoomLevel = calculateZoomLevel(radius * 1609.34);
                    
                    // Create new circle with blue color for Walmart
                    selectedLocationCircle = L.circle(location, {
                        radius: radius * 1609.34, // Convert miles to meters
                        color: '#0d6efd', // Bootstrap primary blue
                        fillColor: '#0d6efd',
                        fillOpacity: 0.1
                    }).addTo(map);
                    
                    // Create a bounds object centered on the location
                    const bounds = selectedLocationCircle.getBounds();
                    
                    // Fit the map to these bounds and force the zoom level
                    map.fitBounds(bounds, {
                        animate: true,
                        duration: 0.3,
                        maxZoom: zoomLevel,
                        padding: [50, 50] // Add some padding around the circle
                    });
                    
                    marker.openPopup();
                });
                
                listContainer.appendChild(div);
                locationsFound++;
            }
        });
    } else {
        linacMarkers.forEach(marker => {
            // For US view, show all markers, for state view, only show those within state boundaries
            let shouldShow = false;
            
            if (selectedState === 'US') {
                shouldShow = true;
            } else if (stateLayer) {
                // Use proper point-in-polygon check instead of bounding box
                shouldShow = isPointInPolygon(marker.getLatLng(), stateLayer);
            }
            
            if (shouldShow) {
                const location = marker.getLatLng();
                const popup = marker.getPopup();
                const content = popup.getContent();
                
                const div = document.createElement('div');
                div.className = 'location-item';
                
                // For LINACs, create custom content that includes the Number of LINACs field
                if (marker.linacData) {
                    div.innerHTML = `
                        <strong>LINAC Center</strong><br>
                        ${marker.linacData['LINAC Name']}<br>
                        Number of LINACs: ${marker.linacData['Number of LINACs']}
                    `;
                } else {
                    div.innerHTML = content;
                }
                
                div.addEventListener('click', () => {
                    // Remove existing circle if any
                    if (selectedLocationCircle) {
                        map.removeLayer(selectedLocationCircle);
                    }
                    
                    // Calculate appropriate zoom level based on radius
                    const zoomLevel = calculateZoomLevel(radius * 1609.34);
                    
                    // Create new circle with blue color for Walmart
                    selectedLocationCircle = L.circle(location, {
                        radius: radius * 1609.34, // Convert miles to meters
                        color: 'red',
                        fillColor: '#f03',
                        fillOpacity: 0.1
                    }).addTo(map);
                    
                    // Create a bounds object centered on the location
                    const bounds = selectedLocationCircle.getBounds();
                    
                    // Fit the map to these bounds and force the zoom level
                    map.fitBounds(bounds, {
                        animate: true,
                        duration: 0.3,
                        maxZoom: zoomLevel,
                        padding: [50, 50] // Add some padding around the circle
                    });
                    
                    marker.openPopup();
                });
                
                listContainer.appendChild(div);
                locationsFound++;
            }
        });
    }

    if (locationsFound === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'location-item text-center text-muted';
        emptyMessage.innerHTML = 'None Found';
        listContainer.appendChild(emptyMessage);
    }
}

// Helper function to check if a marker is within a circle
function isMarkerInCircle(marker, circle) {
    if (!circle) return false;
    
    const markerLatLng = marker.getLatLng();
    const circleLatLng = circle.getLatLng();
    const circleRadius = circle.getRadius();
    
    const distance = markerLatLng.distanceTo(circleLatLng);
    return distance <= circleRadius;
}

// Initialize the application
async function initializeApp() {
    // The loading overlay is already visible from the HTML
    await initializeMap();
    initializeEventListeners();
    await populateStateDropdown();
}

// Call initialization when the page loads
document.addEventListener('DOMContentLoaded', initializeApp);

// Update hideWalmartsNearLinac to use point-in-polygon check
function hideWalmartsNearLinac() {
    console.log('Starting hideWalmartsNearLinac...');
    // Get the current radius value from the input
    const radiusValue = parseFloat(document.getElementById('radius').value);
    console.log(`Radius value: ${radiusValue} miles`);
    console.log(`Total Walmart markers to process: ${walmartMarkers.length}`);
    console.log(`Total LINAC markers to check against: ${linacMarkers.length}`);
    
    let hiddenCount = 0;
    let processedCount = 0;
    
    walmartMarkers.forEach(walmartMarker => {
        // Check if this Walmart is within the specified radius of any LINAC
        const isNearLinac = linacMarkers.some(linacMarker => {
            const distance = walmartMarker.getLatLng().distanceTo(linacMarker.getLatLng()) / 1609.34;
            return distance <= radiusValue;
        });

        if (isNearLinac) {
            walmartMarker.setOpacity(0);  // Hide the marker
            walmartMarker.closePopup();    // Close any open popup
            hiddenCount++;
        }
        
        processedCount++;
        if (processedCount % 100 === 0) {
            console.log(`Processed ${processedCount}/${walmartMarkers.length} Walmart markers...`);
        }
    });

    console.log(`Hiding complete. Hidden ${hiddenCount} Walmart markers.`);
    
    // Update the location list to reflect hidden markers
    console.log('Updating location list...');
    updateLocationList();
    console.log('Process complete.');
}

// Update showAllWalmarts to show all markers
function showAllWalmarts() {
    console.log('Starting showAllWalmarts...');
    console.log(`Total Walmart markers to show: ${walmartMarkers.length}`);
    
    let processedCount = 0;
    
    // Show all Walmart markers
    walmartMarkers.forEach(marker => {
        marker.setOpacity(1);
        processedCount++;
        
        if (processedCount % 100 === 0) {
            console.log(`Processed ${processedCount}/${walmartMarkers.length} Walmart markers...`);
        }
    });

    console.log('All Walmart markers shown.');
    
    // Update the location list to show all markers again
    console.log('Updating location list...');
    updateLocationList();
    console.log('Process complete.');
}

// Update createMetricsTable function
function createMetricsTable() {
    const radius = document.getElementById('radius').value;
    const modalContent = document.getElementById('dashboard-modal');
    modalContent.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">Metrics Table</h5>
                <div>
                    <button type="button" class="btn btn-sm btn-primary me-2" id="download-csv">
                        <i class="fas fa-download"></i> CSV
                    </button>
                    <button type="button" class="btn btn-sm btn-primary me-2" id="download-json">
                        <i class="fas fa-download"></i> JSON
                    </button>
                    <button type="button" class="btn-close" id="close-modal"></button>
                </div>
            </div>
            <div class="modal-body" style="max-height: 80vh; overflow-y: auto;">
                <div class="metrics-table-container">
                    <table class="metrics-table">
                        <thead class="metrics-table-header">
                            <tr>
                                <th>State</th>
                                <th class="text-end">Walmarts Not Within<br>${radius} Miles</th>
                                <th class="text-end">Total<br>Walmarts</th>
                                <th class="text-end">LINAC<br>Centers</th>
                                <th class="text-end">Total<br>LINACs</th>
                            </tr>
                        </thead>
                        <tbody id="metrics-table-body">
                            <tr>
                                <td colspan="5" class="text-center">
                                    <div class="spinner-border text-primary" role="status">
                                        <span class="visually-hidden">Loading...</span>
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

    // Reattach close button listener
    document.getElementById('close-modal').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('d-none');
        document.getElementById('dashboard-modal').classList.add('d-none');
    });

    // Add download button listeners
    document.getElementById('download-csv').addEventListener('click', downloadMetricsCSV);
    document.getElementById('download-json').addEventListener('click', downloadMetricsJSON);

    // Populate table data
    populateTableData();
}

// Add new function to handle CSV download
function downloadMetricsCSV() {
    const radius = document.getElementById('radius').value;
    const table = document.querySelector('.metrics-table');
    let csvContent = `State,Not Within ${radius} Miles,Total Walmarts,LINAC Centers,Total LINACs\n`;

    // Get all table rows
    const rows = table.querySelectorAll('tbody tr');
    
    // Convert each row to CSV
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        const rowData = Array.from(cells)
            .map(cell => {
                // Remove commas from numbers and any special characters
                let text = cell.textContent.trim().replace(/,/g, '');
                // If the cell contains numbers, return as is, otherwise wrap in quotes
                return isNaN(text) ? `"${text}"` : text;
            })
            .join(',');
        csvContent += rowData + '\n';
    });

    // Create and trigger download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `linac-walmart-metrics-${radius}mi.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Add new function to handle JSON download
function downloadMetricsJSON() {
    const radius = document.getElementById('radius').value;
    const table = document.querySelector('.metrics-table');
    const rows = table.querySelectorAll('tbody tr');
    const jsonData = [];
    
    // Convert each row to a JSON object
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 5) {
            const state = cells[0].textContent.trim();
            const walmartsOutsideRange = parseInt(cells[1].textContent.replace(/,/g, '')) || 0;
            const totalWalmarts = parseInt(cells[2].textContent.replace(/,/g, '')) || 0;
            const linacCenters = parseInt(cells[3].textContent.replace(/,/g, '')) || 0;
            const totalLinacs = parseInt(cells[4].textContent.replace(/,/g, '')) || 0;
            
            jsonData.push({
                state,
                walmartsOutsideRange,
                totalWalmarts,
                linacCenters,
                totalLinacs,
                radius: parseInt(radius)
            });
        }
    });
    
    // Create and trigger download
    const jsonString = JSON.stringify(jsonData, null, 2); // Pretty print with 2 spaces
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `linac-walmart-metrics-${radius}mi.json`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Update populateTableData function
async function populateTableData() {
    const tableBody = document.getElementById('metrics-table-body');
    const radius = document.getElementById('radius').value;
    let tableRows = '';
    let usTotals = {
        walmartsOutsideRange: 0,
        totalWalmarts: 0,
        linacCenters: 0,
        totalLinacs: 0
    };

    try {
        console.log(`--- DEBUG: Starting table data population with radius ${radius} ---`);
        // Fetch datasets through API endpoints with cache busting
        const mapData = await fetchWithCacheBusting('/api/map-data?initial=true');
        
        // Extract data from the response
        const walmartData = mapData.walmart || [];
        const linacData = mapData.linac || [];
        
        console.log(`Loaded Walmart locations: ${walmartData.length}`);
        console.log(`Loaded LINAC locations: ${linacData.length}`);
        console.log(`First LINAC: `, JSON.stringify(linacData[0]).substring(0, 200));
        console.log(`Last LINAC: `, JSON.stringify(linacData[linacData.length-1]).substring(0, 200));

        // Sample a few LINAC entries to verify data structure
        console.log(`--- DEBUG: Sampling LINAC entries to verify structure ---`);
        const sampleSize = Math.min(5, linacData.length);
        for (let i = 0; i < sampleSize; i++) {
            const index = Math.floor(Math.random() * linacData.length);
            console.log(`Sample LINAC ${i+1}:`, {
                name: linacData[index]['LINAC Name'],
                state: linacData[index].States,
                lat: linacData[index].Latitude,
                lng: linacData[index].Longitude,
                numLinacs: linacData[index]['Number of LINACs']
            });
        }

        // Process each state
        const states = Array.from(document.getElementById('state').options)
            .map(option => ({ value: option.value, text: option.text }))
            .filter(option => option.value !== 'all' && option.value !== 'US' && option.value !== '')
            .sort((a, b) => a.text.localeCompare(b.text));
        
        // Calculate US totals
        usTotals.totalWalmarts = walmartData.length;
        usTotals.linacCenters = linacData.length;
        usTotals.totalLinacs = linacData.reduce((sum, location) => sum + (parseInt(location['Number of LINACs']) || 0), 0);
        
        // Helper function to calculate distance between two points
        function calculateDistance(lat1, lon1, lat2, lon2) {
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
        
        // Debug for US calculations
        console.log(`--- DEBUG: Starting US total calculations ---`);
        let withinRangeCounter = 0;
        let outsideRangeCounter = 0;
        let invalidCoordCounter = 0;
        
        // Calculate Walmarts outside range for US total
        usTotals.walmartsOutsideRange = 0;
        for (const walmart of walmartData) {
            if (!walmart.latitude || !walmart.longitude) {
                usTotals.walmartsOutsideRange++;
                invalidCoordCounter++;
                continue;
            }
            
            let isWithinRange = false;
            for (const linac of linacData) {
                if (!linac.Latitude || !linac.Longitude) continue;
                
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
                usTotals.walmartsOutsideRange++;
                outsideRangeCounter++;
            } else {
                withinRangeCounter++;
            }
        }
        
        console.log(`US calculations: ${withinRangeCounter} within range, ${outsideRangeCounter} outside range, ${invalidCoordCounter} invalid coords`);
        console.log(`US total Walmarts outside range: ${usTotals.walmartsOutsideRange}`);
        
        // Now calculate for each state
        console.log(`--- DEBUG: Starting state calculations ---`);
        const stateDebug = {};
        
        for (const state of states) {
            // Calculate metrics for each state
            const stateWalmarts = walmartData.filter(location => location.state === state.value);
            const stateLinacCenters = linacData.filter(location => location.States === state.value);
            const stateWalmartsCount = stateWalmarts.length;
            const stateLinacCentersCount = stateLinacCenters.length;
            const stateTotalLinacs = stateLinacCenters.reduce((sum, location) => sum + (parseInt(location['Number of LINACs']) || 0), 0);
            
            // Debug info
            stateDebug[state.value] = {
                walmarts: stateWalmartsCount,
                linacCenters: stateLinacCentersCount,
                totalLinacs: stateTotalLinacs
            };
            
            // Calculate Walmarts outside range for this state
            let stateWalmartsOutsideRange = 0;
            let stateWithinRange = 0;
            let stateInvalidCoords = 0;
            
            for (const walmart of stateWalmarts) {
                if (!walmart.latitude || !walmart.longitude) {
                    stateWalmartsOutsideRange++;
                    stateInvalidCoords++;
                    continue;
                }
                
                let isWithinRange = false;
                for (const linac of linacData) {
                    if (!linac.Latitude || !linac.Longitude) continue;
                    
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
                    stateWalmartsOutsideRange++;
                } else {
                    stateWithinRange++;
                }
            }
            
            stateDebug[state.value].outsideRange = stateWalmartsOutsideRange;
            stateDebug[state.value].withinRange = stateWithinRange;
            stateDebug[state.value].invalidCoords = stateInvalidCoords;

            tableRows += `
                <tr>
                    <td>${state.text}</td>
                    <td class="text-end">${stateWalmartsOutsideRange.toLocaleString()}</td>
                    <td class="text-end">${stateWalmartsCount.toLocaleString()}</td>
                    <td class="text-end">${stateLinacCentersCount.toLocaleString()}</td>
                    <td class="text-end">${stateTotalLinacs.toLocaleString()}</td>
                </tr>
            `;
        }
        
        console.log('State debug info:', stateDebug);

        // Add US totals row at the beginning
        const usTotalRow = `
            <tr class="us-total-row">
                <td><strong>United States</strong></td>
                <td class="text-end"><strong>${usTotals.walmartsOutsideRange.toLocaleString()}</strong></td>
                <td class="text-end"><strong>${usTotals.totalWalmarts.toLocaleString()}</strong></td>
                <td class="text-end"><strong>${usTotals.linacCenters.toLocaleString()}</strong></td>
                <td class="text-end"><strong>${usTotals.totalLinacs.toLocaleString()}</strong></td>
            </tr>
        `;

        tableBody.innerHTML = usTotalRow + tableRows;
        console.log(`--- DEBUG: Table population complete ---`);
    } catch (error) {
        console.error('Error loading data for table:', error);
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" class="text-center text-danger">
                    Error loading data: ${error.message}
                </td>
            </tr>
        `;
    }
}

// Add function to check dataset details
async function checkDatasetDetails() {
    try {
        const response = await fetch('/api/map-data?initial=true');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        // Extract information from the response
        const walmartCount = data.walmart ? data.walmart.length : 0;
        const linacCount = data.linac ? data.linac.length : 0;
        
        // Get first and last linac entries to check version
        const firstLinac = data.linac && data.linac.length > 0 ? data.linac[0] : null;
        const lastLinac = data.linac && data.linac.length > 0 ? data.linac[data.linac.length - 1] : null;
        
        console.log('=== Dataset Details ===');
        console.log(`Total Walmart Locations: ${walmartCount}`);
        console.log(`Total LINAC Locations: ${linacCount}`);
        if (firstLinac) {
            console.log('First LINAC Entry:');
            console.log(firstLinac);
        }
        if (lastLinac) {
            console.log('Last LINAC Entry:');
            console.log(lastLinac);
        }
        
        return {
            walmartCount,
            linacCount,
            firstLinac,
            lastLinac
        };
    } catch (error) {
        console.error('Error checking dataset details:', error);
        return null;
    }
}

// Call this function whenever you need to check dataset details
document.addEventListener('DOMContentLoaded', () => {
    // Add this to the existing DOMContentLoaded event listener
    setTimeout(() => {
        checkDatasetDetails();
    }, 1000); // Wait for 1 second after page loads
});

// Update getLegendHTML function
function getLegendHTML() {
    const radius = document.getElementById('radius')?.value || '35';
    
    if (walmartsHidden) {
        return `
            <div>
                <img src="/images/markers/marker-icon-blue.png" alt="Walmart">
                Walmarts > ${radius} miles away from a LINAC Center
            </div>
            <div>
                <img src="/images/markers/marker-icon-red.png" alt="LINAC">
                LINAC Centers
            </div>
        `;
    } else {
        return `
            <div>
                <img src="/images/markers/marker-icon-blue.png" alt="Walmart">
                Walmart Locations
            </div>
            <div>
                <img src="/images/markers/marker-icon-red.png" alt="LINAC">
                LINAC Centers
            </div>
        `;
    }
}

// Function to update legend
function updateLegend() {
    if (legendControl) {
        // Remove the old legend
        map.removeControl(legendControl);
        
        // Create new legend with updated text
        legendControl = L.control({ position: 'bottomleft' });
        legendControl.onAdd = function(map) {
            const div = L.DomUtil.create('div', 'legend');
            div.innerHTML = getLegendHTML();
            return div;
        };
        legendControl.addTo(map);
    }
}