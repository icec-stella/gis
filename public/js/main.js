// Global variables
let map;
let walmartMarkers = [];
let linacMarkers = [];
let radiusCircles = [];
let stateLayer;
let selectedLocationCircle = null;

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

    // Remove cluster group initialization
    await loadInitialMarkers();
}

// Update loadInitialMarkers to use regular markers
async function loadInitialMarkers() {
    try {
        const response = await fetch('/api/map-data?initial=true');
        const data = await response.json();
        
        // Clear existing markers
        clearMap();
        
        // Add Walmart markers
        data.walmart.forEach(location => {
            const marker = L.marker([location.latitude, location.longitude], {
                icon: blueMarkerIcon
            }).addTo(map);
            
            marker.bindPopup(`
                <strong>Walmart</strong><br>
                ${location.name}<br>
                ${location.street_address}<br>
                ${location.city}, ${location.state}
            `);
            
            walmartMarkers.push(marker);
        });

        // Add LINAC markers
        data.linac
            .filter(location => location.Latitude && location.Longitude)
            .forEach(location => {
                const marker = L.marker([location.Latitude, location.Longitude], {
                    icon: redMarkerIcon
                }).addTo(map);
                
                marker.bindPopup(`
                    <strong>LINAC Center</strong><br>
                    ${location['LINAC Name']}
                `);
                
                linacMarkers.push(marker);
            });

        console.log(`Loaded ${walmartMarkers.length} Walmart markers and ${linacMarkers.length} LINAC markers`);
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

    radiusSlider.addEventListener('input', (e) => {
        radiusValue.textContent = e.target.value;
        
        // Update circle radius if one exists
        if (selectedLocationCircle) {
            selectedLocationCircle.setRadius(e.target.value * 1609.34);
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
    document.getElementById('dashboard-button').addEventListener('click', () => {
        const selectedState = document.getElementById('state').value;
        const dashboardTitle = document.getElementById('dashboard-title');
        
        // Update title with selected state
        if (selectedState && selectedState !== 'all') {
            dashboardTitle.textContent = `Dashboard - ${selectedState}`;
        } else {
            dashboardTitle.textContent = 'Dashboard';
        }
        
        document.getElementById('modal-overlay').classList.remove('d-none');
        document.getElementById('dashboard-modal').classList.remove('d-none');
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

    // Add toggle Walmarts button listener
    const toggleWalmartsBtn = document.getElementById('toggle-walmarts');
    toggleWalmartsBtn.addEventListener('click', () => {
        const isHiding = toggleWalmartsBtn.textContent === 'Hide Walmarts';
        
        if (isHiding) {
            hideWalmartsNearLinac();
            toggleWalmartsBtn.textContent = 'Show All Walmarts';
        } else {
            showAllWalmarts();
            toggleWalmartsBtn.textContent = 'Hide Walmarts';
        }
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

// Display metrics in dashboard
function displayMetrics(metrics) {
    const sideMetricsContainer = document.getElementById('dashboard-metrics');
    const modalMetricsContainer = document.getElementById('modal-dashboard-metrics');
    
    console.log('Displaying metrics:', metrics);
    
    if (metrics) {
        console.log('Metrics values:', {
            outside: metrics.walmartsOutsideRange,
            within: metrics.walmartsWithinRange,
            centers: metrics.cityCentersWithinRange,
            linacs: metrics.linacsWithinRange
        });

        const metricsHTML = `
            <div class="metric-card">
                <div class="metric-value">${metrics.walmartsOutsideRange || 0}</div>
                <div class="metric-label">Walmarts Not Within 35 Miles of LINAC</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">${metrics.walmartsWithinRange || 0}</div>
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

        // Update both containers
        modalMetricsContainer.innerHTML = metricsHTML;
        sideMetricsContainer.innerHTML = ''; // Clear the side metrics
    } else {
        console.log('No metrics data received');
        modalMetricsContainer.innerHTML = '';
        sideMetricsContainer.innerHTML = '';
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
        const city = document.getElementById('city').value;
        
        const response = await fetch(`/api/metrics?radius=${radius}&city=${city}`);
        const metrics = await response.json();
        
        // Update metrics display (will implement later)
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
        map.fitBounds(stateLayer.getBounds());
        
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

// Update updateAnalysis function to handle boundary loading failures
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

        if (state === 'US') {
            // Clear any existing state boundary
            if (stateLayer) {
                map.removeLayer(stateLayer);
                stateLayer = null;
            }
            
            // Set view to continental US
            map.setView([39.8283, -98.5795], 4);

            // Calculate nationwide metrics
            const walmartsNotNearLinac = walmartMarkers.filter(walmartMarker => {
                // Check if this Walmart is within 35 miles of any LINAC
                const isNearAnyLinac = linacMarkers.some(linacMarker => {
                    const distance = walmartMarker.getLatLng().distanceTo(linacMarker.getLatLng()) / 1609.34;
                    return distance <= 35;
                });
                return !isNearAnyLinac;
            });

            // Update metrics for nationwide view
            const metrics = {
                walmartsOutsideRange: walmartsNotNearLinac.length,
                walmartsWithinRange: walmartMarkers.length,
                cityCentersWithinRange: linacMarkers.length,
                linacsWithinRange: linacMarkers.length
            };

            console.log('\nNationwide Metrics:');
            console.log('Total Walmarts:', metrics.walmartsWithinRange);
            console.log('Walmarts Not Near LINAC:', metrics.walmartsOutsideRange);
            console.log('Total LINAC Centers:', metrics.cityCentersWithinRange);
            console.log('Total LINACs:', metrics.linacsWithinRange);

            displayMetrics(metrics);
            updateLocationList();
        } else {
            // Load state boundary and wait for result
            const boundaryLoaded = await loadStateBoundary(state);
            
            if (!boundaryLoaded || !stateLayer) {
                throw new Error('Failed to load state boundary');
            }

            console.log(`\n=== Analysis for ${state} ===`);
            console.log('Total Walmarts loaded:', walmartMarkers.length);
            console.log('Total LINAC Centers loaded:', linacMarkers.length);

            const walmartInState = walmartMarkers.filter(marker => 
                stateLayer.getBounds().contains(marker.getLatLng())
            );
            const linacInState = linacMarkers.filter(marker => 
                stateLayer.getBounds().contains(marker.getLatLng())
            );

            const walmartsNotNearLinac = walmartInState.filter(walmartMarker => {
                const isNearAnyLinac = linacInState.some(linacMarker => {
                    const distance = walmartMarker.getLatLng().distanceTo(linacMarker.getLatLng()) / 1609.34;
                    return distance <= 35;
                });
                return !isNearAnyLinac;
            });

            const metrics = {
                walmartsOutsideRange: walmartsNotNearLinac.length,
                walmartsWithinRange: walmartInState.length,
                cityCentersWithinRange: linacInState.length,
                linacsWithinRange: linacInState.length
            };

            displayMetrics(metrics);
            updateLocationList();
        }

        hideLoading();
    } catch (error) {
        console.error('Error updating analysis:', error);
        hideLoading();
        
        // Show error message to user
        const metricsContainer = document.getElementById('dashboard-metrics');
        metricsContainer.innerHTML = `
            <div class="alert alert-danger">
                Error loading state data. Please try again later.
            </div>
        `;
    }
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
                    
                    // Create new circle
                    selectedLocationCircle = L.circle(location, {
                        radius: radius * 1609.34, // Convert miles to meters
                        color: 'red',
                        fillColor: '#f03',
                        fillOpacity: 0.1
                    }).addTo(map);
                    
                    // Calculate appropriate zoom level based on radius
                    const zoomLevel = calculateZoomLevel(radius * 1609.34);
                    
                    // Get the sidebar width
                    const sidebarWidth = document.querySelector('.col-md-3').getBoundingClientRect().width;
                    
                    // Calculate the center point with offset
                    const targetLatLng = map.layerPointToLatLng(
                        map.latLngToLayerPoint(location).add([sidebarWidth/2, 0])
                    );
                    
                    // Set the view to the offset center
                    map.setView(targetLatLng, zoomLevel, {
                        animate: true,
                        duration: 0.3
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
                    
                    // Create new circle
                    selectedLocationCircle = L.circle(location, {
                        radius: radius * 1609.34, // Convert miles to meters
                        color: 'red',
                        fillColor: '#f03',
                        fillOpacity: 0.1
                    }).addTo(map);
                    
                    // Calculate appropriate zoom level based on radius
                    const zoomLevel = calculateZoomLevel(radius * 1609.34);
                    
                    // Get the sidebar width
                    const sidebarWidth = document.querySelector('.col-md-3').getBoundingClientRect().width;
                    
                    // Calculate the center point with offset
                    const targetLatLng = map.layerPointToLatLng(
                        map.latLngToLayerPoint(location).add([sidebarWidth/2, 0])
                    );
                    
                    // Set the view to the offset center
                    map.setView(targetLatLng, zoomLevel, {
                        animate: true,
                        duration: 0.3
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
    
    const metricsContainer = document.getElementById('dashboard-metrics');
    metricsContainer.innerHTML = '';
}

// Call initialization when the page loads
document.addEventListener('DOMContentLoaded', initializeApp);

// Update hideWalmartsNearLinac to trigger list update
function hideWalmartsNearLinac() {
    if (!stateLayer) return;

    const walmartInState = walmartMarkers.filter(marker => 
        stateLayer.getBounds().contains(marker.getLatLng())
    );
    const linacInState = linacMarkers.filter(marker => 
        stateLayer.getBounds().contains(marker.getLatLng())
    );

    walmartInState.forEach(walmartMarker => {
        // Check if this Walmart is within 35 miles of any LINAC
        const isNearLinac = linacInState.some(linacMarker => {
            const distance = walmartMarker.getLatLng().distanceTo(linacMarker.getLatLng()) / 1609.34;
            return distance <= 35;
        });

        if (isNearLinac) {
            walmartMarker.setOpacity(0);  // Hide the marker
            walmartMarker.closePopup();    // Close any open popup
        }
    });

    // Update the location list to reflect hidden markers
    updateLocationList();
}

// Update showAllWalmarts to trigger list update
function showAllWalmarts() {
    if (!stateLayer) return;

    const walmartInState = walmartMarkers.filter(marker => 
        stateLayer.getBounds().contains(marker.getLatLng())
    );

    walmartInState.forEach(marker => {
        marker.setOpacity(1);  // Show the marker
    });

    // Update the location list to show all markers again
    updateLocationList();
} 