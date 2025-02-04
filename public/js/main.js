// Global variables
let map;
let walmartMarkers = [];
let linacMarkers = [];
let radiusCircles = [];
let stateLayer;
let selectedLocationCircle = null;
let usBoundaryLayer;

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

// Initialize the map
async function initializeMap() {
    map = L.map('map', {
        preferCanvas: true, // Keep Canvas renderer
        wheelDebounceTime: 150, // Keep wheel debounce
        wheelPxPerZoomLevel: 120, // Keep zoom sensitivity
        zoomSnap: 0.5, // Keep smooth zooming
        zoomDelta: 0.5, // Keep smooth zooming
    }).setView([39.8283, -98.5795], 4);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // Add legend
    const legend = L.control({ position: 'bottomleft' });

    legend.onAdd = function(map) {
        const div = L.DomUtil.create('div', 'legend');
        div.innerHTML = `
            <div>
                <img src="/images/markers/marker-icon-blue.png" alt="Walmart">
                Walmart Locations
            </div>
            <div>
                <img src="/images/markers/marker-icon-red.png" alt="LINAC">
                LINAC Centers
            </div>
        `;
        return div;
    };

    legend.addTo(map);

    // Load US boundary first
    try {
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
    } catch (error) {
        console.error('Error loading US boundary:', error);
    }

    // Remove cluster group initialization
    await loadInitialMarkers();
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

// Update loadInitialMarkers function
async function loadInitialMarkers() {
    try {
        const response = await fetch('/api/map-data?initial=true');
        const data = await response.json();
        
        clearMap();
        
        // Add Walmart markers only if within US bounds
        data.walmart.forEach(location => {
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
        });

        // Add LINAC markers only if within US bounds and has valid coordinates
        data.linac
            .filter(location => {
                // Check if coordinates exist and are valid numbers
                const hasValidCoords = location.Latitude && 
                                     location.Longitude && 
                                     !isNaN(location.Latitude) && 
                                     !isNaN(location.Longitude);
                
                // Check if coordinates are within US bounds
                return hasValidCoords && 
                       isValidUSCoordinate(parseFloat(location.Latitude), 
                                         parseFloat(location.Longitude));
            })
            .forEach(location => {
                const latLng = L.latLng(location.Latitude, location.Longitude);
                
                // Additional check with US boundary layer if available
                if (!usBoundaryLayer || usBoundaryLayer.getBounds().contains(latLng)) {
                    const marker = L.marker(latLng, {
                        icon: redMarkerIcon
                    }).addTo(map);
                    
                    marker.bindPopup(`
                        <strong>LINAC Center</strong><br>
                        ${location['LINAC Name']}
                    `);
                    
                    linacMarkers.push(marker);
                }
            });

        console.log(`Loaded ${walmartMarkers.length} Walmart markers and ${linacMarkers.length} LINAC markers within US bounds`);
    } catch (error) {
        console.error('Error loading initial markers:', error);
    }
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
        const dashboardTitle = document.getElementById('dashboard-title');
        
        // Update title with selected state
        if (selectedState && selectedState !== 'all') {
            dashboardTitle.textContent = `Dashboard - ${selectedState}`;
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
    toggleWalmartsBtn.addEventListener('click', () => {
        const isHiding = toggleWalmartsBtn.textContent === 'Hide Walmarts';
        const selectedState = document.getElementById('state').value;
        
        // Only allow toggling if a state is selected (not US or all)
        if (selectedState && selectedState !== 'all' && selectedState !== 'US') {
            if (isHiding) {
                hideWalmartsNearLinac();
                toggleWalmartsBtn.textContent = 'Show All Walmarts';
            } else {
                showAllWalmarts();
                toggleWalmartsBtn.textContent = 'Hide Walmarts';
            }
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
    document.getElementById('loading-spinner').classList.remove('d-none');
    document.getElementById('analysis-content').classList.add('d-none');
}

// Update hideLoading function to include a smooth transition
function hideLoading() {
    // Add a small delay to ensure all content is ready before transition
    setTimeout(() => {
        document.getElementById('loading-spinner').classList.add('d-none');
        document.getElementById('analysis-content').classList.remove('d-none');
    }, 500); // 500ms delay for smooth transition
}

// Update populateStateDropdown to populateStateDropdown
async function populateStateDropdown() {
    try {
        const response = await fetch('/api/states');
        const states = await response.json();
        
        const stateSelect = document.getElementById('state');
        
        // Add United States option at the top
        const usOption = document.createElement('option');
        usOption.value = 'US';
        usOption.textContent = 'United States';
        stateSelect.insertBefore(usOption, stateSelect.firstChild);
        
        // Add the default "Select State" option
        const defaultOption = document.createElement('option');
        defaultOption.value = 'all';
        defaultOption.textContent = 'Select State';
        defaultOption.disabled = true;
        stateSelect.insertBefore(defaultOption, stateSelect.firstChild);
        
        // Add all states
        states.forEach(state => {
            const option = document.createElement('option');
            option.value = state;
            option.textContent = state;
            stateSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading states:', error);
    }
}

// Update loadStateBoundary function
async function loadStateBoundary(state) {
    console.log(`[Frontend] Starting to load boundary for state: ${state}`);
    try {
        // Clear existing state boundary
        if (stateLayer) {
            console.log('[Frontend] Clearing existing state layer');
            map.removeLayer(stateLayer);
            stateLayer = null;
        }

        const response = await fetch(`/api/state-boundary/${state}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data || !data[0] || !data[0].geojson) {
            throw new Error('Invalid GeoJSON data received');
        }

        console.log('[Frontend] Creating new state boundary layer');
        stateLayer = L.geoJSON(data[0].geojson, {
            style: {
                color: '#0d6efd',
                weight: 2,
                fillOpacity: 0.1
            }
        }).addTo(map);

        console.log('[Frontend] Fitting map to state bounds');
        
        // Special handling for Alaska
        if (state === 'AK') {
            // Custom bounds for Alaska that exclude far western Aleutian Islands
            const akBounds = L.latLngBounds(
                L.latLng(51.214183, -179.148909), // Southwest corner
                L.latLng(71.365162, -130.001476)  // Northeast corner
            );
            map.fitBounds(akBounds, {
                padding: [50, 50],
                maxZoom: 5  // Limit max zoom for Alaska
            });
        } else {
            // Normal handling for other states
            map.fitBounds(stateLayer.getBounds(), {
                padding: [50, 50]
            });
        }
        
        return true; // Return true to indicate success
    } catch (error) {
        console.error('[Frontend] Error loading state boundary:', error);
        console.error('[Frontend] Error details:', {
            message: error.message,
            stack: error.stack
        });
        return false; // Return false to indicate failure
    }
}

// Update updateAnalysis function to properly filter markers
async function updateAnalysis() {
    const state = document.getElementById('state').value;

    if (!state || state === 'all') {
        console.log('No state selected');
        document.getElementById('loading-spinner').classList.add('d-none');
        document.getElementById('analysis-content').classList.add('d-none');
        return;
    }

    try {
        showLoading();

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
            // For US view, show all markers, for state view, only show those in bounds
            if ((selectedState === 'US' || 
                (stateLayer && stateLayer.getBounds().contains(marker.getLatLng()))) && 
                marker.options.opacity !== 0) {
                
                const location = marker.getLatLng();
                const popup = marker.getPopup();
                const content = popup.getContent();
                
                const div = document.createElement('div');
                div.className = 'location-item';
                div.innerHTML = content;
                
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
            if (selectedState === 'US' || 
                (stateLayer && stateLayer.getBounds().contains(marker.getLatLng()))) {
                
                const location = marker.getLatLng();
                const popup = marker.getPopup();
                const content = popup.getContent();
                
                const div = document.createElement('div');
                div.className = 'location-item';
                div.innerHTML = content;
                
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
    await initializeMap();
    initializeEventListeners();
    await populateStateDropdown();
}

// Call initialization when the page loads
document.addEventListener('DOMContentLoaded', initializeApp);

// Update hideWalmartsNearLinac to use point-in-polygon check
function hideWalmartsNearLinac() {
    // Get the current radius value from the input
    const radiusValue = parseFloat(document.getElementById('radius').value);
    
    walmartMarkers.forEach(walmartMarker => {
        // Check if this Walmart is within the specified radius of any LINAC
        const isNearLinac = linacMarkers.some(linacMarker => {
            const distance = walmartMarker.getLatLng().distanceTo(linacMarker.getLatLng()) / 1609.34;
            return distance <= radiusValue;
        });

        if (isNearLinac) {
            walmartMarker.setOpacity(0);  // Hide the marker
            walmartMarker.closePopup();    // Close any open popup
        }
    });

    // Update the location list to reflect hidden markers
    updateLocationList();
}

// Update showAllWalmarts to show all markers
function showAllWalmarts() {
    // Show all Walmart markers
    walmartMarkers.forEach(marker => {
        marker.setOpacity(1);
    });

    // Update the location list to show all markers again
    updateLocationList();
}

// Update createMetricsTable function to include the radius in the header
function createMetricsTable() {
    const radius = document.getElementById('radius').value;
    let tableHTML = `
        <div class="metrics-table-container">
            <table class="metrics-table">
                <thead class="metrics-table-header">
                    <tr>
                        <th></th>
                        <th class="text-end">Not Within<br>${radius} Miles</th>
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
    `;

    // Update modal content
    const modalContent = document.getElementById('dashboard-modal');
    modalContent.innerHTML = `
        <div class="modal-header">
            <div></div>
            <button type="button" class="btn-close" id="close-modal"></button>
        </div>
        <div class="modal-body" style="max-height: 80vh; overflow-y: auto;">
            ${tableHTML}
        </div>
    `;

    // Reattach close button listener
    document.getElementById('close-modal').addEventListener('click', () => {
        document.getElementById('modal-overlay').classList.add('d-none');
        document.getElementById('dashboard-modal').classList.add('d-none');
    });

    // Populate table data
    populateTableData();
}

// Update populateTableData function
async function populateTableData() {
    const tableBody = document.getElementById('metrics-table-body');
    const radius = document.getElementById('radius').value;
    let tableRows = '';
    let usTotals = {
        walmartsOutsideRange: 0,
        walmartsWithinRange: 0,
        cityCentersWithinRange: 0,
        linacsWithinRange: 0
    };

    // Process each state and accumulate US totals
    const states = Array.from(document.getElementById('state').options)
        .map(option => ({ value: option.value, text: option.text }))
        .filter(option => option.value !== 'all' && option.value !== 'US')
        .sort((a, b) => a.text.localeCompare(b.text));
    
    for (const state of states) {
        try {
            const response = await fetch(`/api/metrics?state=${state.value}&radius=${radius}`);
            const metrics = await response.json();

            // Add to US totals
            usTotals.walmartsOutsideRange += metrics.walmartsOutsideRange;
            usTotals.walmartsWithinRange += metrics.walmartsWithinRange;
            usTotals.cityCentersWithinRange += metrics.cityCentersWithinRange;
            usTotals.linacsWithinRange += metrics.linacsWithinRange;

            tableRows += `
                <tr>
                    <td>${state.text}</td>
                    <td class="text-end">${metrics.walmartsOutsideRange.toLocaleString()}</td>
                    <td class="text-end">${metrics.walmartsWithinRange.toLocaleString()}</td>
                    <td class="text-end">${metrics.cityCentersWithinRange.toLocaleString()}</td>
                    <td class="text-end">${metrics.linacsWithinRange.toLocaleString()}</td>
                </tr>
            `;
        } catch (error) {
            console.error(`Error fetching metrics for ${state.text}:`, error);
            tableRows += `
                <tr>
                    <td>${state.text}</td>
                    <td colspan="4" class="text-center text-danger">Error loading data</td>
                </tr>
            `;
        }
    }

    // Add US totals row at the beginning
    const usTotalRow = `
        <tr class="us-total-row">
            <td>United States</td>
            <td class="text-end"><strong>${usTotals.walmartsOutsideRange.toLocaleString()}</strong></td>
            <td class="text-end"><strong>${usTotals.walmartsWithinRange.toLocaleString()}</strong></td>
            <td class="text-end"><strong>${usTotals.cityCentersWithinRange.toLocaleString()}</strong></td>
            <td class="text-end"><strong>${usTotals.linacsWithinRange.toLocaleString()}</strong></td>
        </tr>
    `;

    tableBody.innerHTML = usTotalRow + tableRows;
} 