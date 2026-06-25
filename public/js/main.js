// Global variables
let map;
let walmartMarkers = [];
let linacMarkers = [];
let hospitalMarkers = [];
/** Purple ring markers — OSRM systemic-gap Walmarts; not affected by Hide Walmarts. */
let systemicGapMarkers = [];
let stateLayer;
let usBoundaryLayer;
let legendControl; // Add global reference to legend control
let walmartsHidden = false; // Track if Walmarts are being hidden
/** OSRM LINAC-gap pin keys from the latest /api/metrics response (lat,lng at 7 dp). */
let osrmLinacGapPinKeys = null;

/**
 * Fixed hospital backstop drive-time ceiling — must match server.js HOSPITAL_BACKSTOP_MINUTES.
 * Used for table headers / CSV labels that render before any /api/metrics response arrives;
 * live responses also carry it as `metrics.hospitalBackstopMinutes` (preferred where available).
 */
const HOSPITAL_BACKSTOP_MINUTES = 30;

function getDriveTimeMinutes() {
    const el = document.getElementById('max-drive-minutes');
    if (!el) return 60;
    const v = parseFloat(el.value, 10);
    return Number.isFinite(v) ? v : 60;
}

/** Shared dashboard modal grid (LINAC gaps + viable/systemic splits + inventory). */
function formatDashboardCardsHTML(metrics, minutes) {
    const m = metrics || {};
    const hospMin = Number.isFinite(m.hospitalBackstopMinutes) ? m.hospitalBackstopMinutes : HOSPITAL_BACKSTOP_MINUTES;
    return `
        <div class="metric-card">
            <div class="metric-value">${m.walmartsOutsideRange || 0}</div>
            <div class="metric-label">No LINAC within ${minutes} min (OSRM)</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.viableGapWalmarts || 0}</div>
            <div class="metric-label">Viable gap — no LINAC, general acute or critical access hospital ≤ ${hospMin} min (OSRM)</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.systemicGapWalmarts || 0}</div>
            <div class="metric-label">Systemic gap — no LINAC, no general acute or critical access hospital within ${hospMin} min</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.totalWalmarts || 0}</div>
            <div class="metric-label">Total Walmarts in State</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.cityCentersWithinRange || 0}</div>
            <div class="metric-label">LINAC Centers in State</div>
        </div>
        <div class="metric-card">
            <div class="metric-value">${m.linacsWithinRange || 0}</div>
            <div class="metric-label">Total LINACs in State</div>
        </div>
    `;
}

/** Pan/zoom to a point when a location is selected from the map or list (no drive-time circle). */
function flyMapTo(latLng, preferredZoom = 12) {
    if (!map || !latLng) return;
    const z = Math.max(preferredZoom, map.getZoom());
    map.flyTo(latLng, z, { animate: true, duration: 0.35 });
}

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

const yellowMarkerIcon = L.icon({
    iconUrl: '/images/markers/marker-icon-yellow.png',
    iconSize: [12, 20],
    iconAnchor: [6, 20],
    popupAnchor: [1, -17]
});

function escapePopupText(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

/**
 * Find the blue Walmart marker whose source row matches a systemic-gap pin's coordinates.
 * Both the marker (via marker.walmartData.latitude/longitude) and the pin originate from the
 * same JSON row, so equality is exact in practice; the small epsilon is defensive.
 */
function findWalmartMarkerByCoords(lat, lng) {
    const EPS = 1e-9;
    for (const m of walmartMarkers) {
        const w = m.walmartData;
        if (!w) continue;
        const wlat = Number(w.latitude);
        const wlng = Number(w.longitude);
        if (Math.abs(wlat - lat) < EPS && Math.abs(wlng - lng) < EPS) {
            return m;
        }
    }
    return null;
}

function pinCoordKey(lat, lng) {
    return `${Number(lat).toFixed(7)},${Number(lng).toFixed(7)}`;
}

function buildLinacGapPinKeySet(pins) {
    const set = new Set();
    if (!Array.isArray(pins)) {
        return set;
    }
    for (const p of pins) {
        if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
            set.add(pinCoordKey(p.latitude, p.longitude));
        }
    }
    return set;
}

function setOsrmLinacGapPinsFromMetrics(metrics) {
    osrmLinacGapPinKeys = buildLinacGapPinKeySet(metrics && metrics.linacGapWalmartPins);
    return osrmLinacGapPinKeys;
}

function isWalmartMarkerOsrmLinacGap(marker, gapKeys) {
    const w = marker.walmartData;
    if (!w || !gapKeys) {
        return false;
    }
    const lat = Number(w.latitude);
    const lng = Number(w.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return false;
    }
    return gapKeys.has(pinCoordKey(lat, lng));
}

/** Show only OSRM LINAC-gap Walmarts in the selected scope; hide all others. */
function applyOsrmLinacGapVisibility(gapKeys, selectedState) {
    let hiddenCount = 0;
    let visibleGapCount = 0;

    walmartMarkers.forEach((marker) => {
        if (marker._hiddenBySystemicGap) {
            return;
        }
        const w = marker.walmartData;
        if (!w) {
            return;
        }

        const inScope = selectedState === 'US' || w.state === selectedState;
        if (!inScope) {
            marker.setOpacity(0);
            marker.closePopup();
            hiddenCount++;
            return;
        }

        if (isWalmartMarkerOsrmLinacGap(marker, gapKeys)) {
            marker.setOpacity(1);
            visibleGapCount++;
        } else {
            marker.setOpacity(0);
            marker.closePopup();
            hiddenCount++;
        }
    });

    return { hiddenCount, visibleGapCount };
}

function clearSystemicGapMarkers() {
    if (map) {
        systemicGapMarkers.forEach((layer) => {
            try {
                map.removeLayer(layer);
            } catch (e) {
                /* noop */
            }
        });
    }
    systemicGapMarkers = [];

    // Restore Walmart pins that were hidden specifically because a systemic-gap ring covered them.
    // If Hide Walmarts is on, re-apply OSRM gap visibility for the current state.
    const selectedState = document.getElementById('state')?.value;
    walmartMarkers.forEach((marker) => {
        if (!marker._hiddenBySystemicGap) return;
        marker._hiddenBySystemicGap = false;
        if (!walmartsHidden) {
            marker.setOpacity(1);
            return;
        }
    });
    if (walmartsHidden && osrmLinacGapPinKeys && selectedState && selectedState !== 'all') {
        applyOsrmLinacGapVisibility(osrmLinacGapPinKeys, selectedState);
    }
}

/**
 * Purple rings — Walmart locations that are OSRM systemic gaps (no LINAC + no general acute or
 * critical access hospital ≤ cutoff). The ring is the authoritative symbol at these locations;
 * the underlying blue Walmart pin is hidden to give every location exactly one visual marker.
 */
function syncSystemicGapPinsFromMetrics(metrics) {
    setOsrmLinacGapPinsFromMetrics(metrics);
    clearSystemicGapMarkers();
    const st = document.getElementById('state')?.value;
    if (!map || !st || st === 'all') {
        updateLegend();
        return;
    }
    if (st === 'US') {
        if (walmartsHidden && osrmLinacGapPinKeys) {
            applyOsrmLinacGapVisibility(osrmLinacGapPinKeys, 'US');
            updateLocationList();
        }
        updateLegend();
        return;
    }
    const minutes = getDriveTimeMinutes();
    const hospMin = metrics && Number.isFinite(metrics.hospitalBackstopMinutes)
        ? metrics.hospitalBackstopMinutes
        : HOSPITAL_BACKSTOP_MINUTES;
    const pins = metrics && Array.isArray(metrics.systemicGapWalmartPins) ? metrics.systemicGapWalmartPins : [];
    pins.forEach((p) => {
        const lat = p.latitude;
        const lng = p.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return;
        }
        const cm = L.circleMarker([lat, lng], {
            radius: 11,
            weight: 3,
            color: '#4a148c',
            fillColor: '#e1bee7',
            fillOpacity: 0.95
        }).addTo(map);
        try {
            if (typeof cm.bringToFront === 'function') {
                cm.bringToFront();
            }
        } catch (e) {
            /* noop */
        }
        const addrParts = [];
        if (p.street_address && String(p.street_address).trim()) {
            addrParts.push(String(p.street_address).trim());
        }
        let cityLine = '';
        const cty = p.city != null ? String(p.city).trim() : '';
        const sta = p.state != null ? String(p.state).trim() : '';
        if (cty && sta) {
            cityLine = `${cty}, ${sta}`;
        } else if (cty || sta) {
            cityLine = cty || sta;
        }
        if (cityLine) {
            addrParts.push(cityLine);
        }
        const addrHtml = addrParts.map(escapePopupText).join('<br>');
        cm.bindPopup(
            `<strong>Systemic gap</strong> (OSRM)<br>No LINAC within ${escapePopupText(minutes)} min and no general acute or critical access hospital within ${escapePopupText(hospMin)} min.<br>${escapePopupText(p.name || '')}${addrHtml ? `<br>${addrHtml}` : ''}`
        );
        cm.on('click', () => {
            flyMapTo(L.latLng(lat, lng), 14);
            cm.openPopup();
        });
        systemicGapMarkers.push(cm);

        // Suppress the blue Walmart pin at this location — the ring is the authoritative symbol.
        const underlying = findWalmartMarkerByCoords(lat, lng);
        if (underlying) {
            underlying._hiddenBySystemicGap = true;
            underlying.setOpacity(0);
            underlying.closePopup();
        }
    });
    if (pins.length > 0) {
        console.log(
            `[Map] ${pins.length} systemic-gap location(s) — purple rings (OSRM classification)`
        );
    }
    if (walmartsHidden && osrmLinacGapPinKeys && st && st !== 'all') {
        applyOsrmLinacGapVisibility(osrmLinacGapPinKeys, st);
        updateLocationList();
    }
    updateLegend();
}

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

async function parseJsonOrThrow(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const msg =
            body && typeof body === 'object' && body.message
                ? String(body.message)
                : body && typeof body === 'object' && body.error
                  ? String(body.error)
                  : `HTTP ${response.status}`;
        throw new Error(msg);
    }
    return body;
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
    return parseJsonOrThrow(response);
}

// Update loadInitialMarkers function
async function loadInitialMarkers() {
    try {
        const response = await fetchWithCacheBusting('/api/map-data?initial=true');
        const data = response;
        
        clearMap();
        
        // Create a counter for loaded markers
        let loadedMarkers = 0;
        const hospitalsRaw = Array.isArray(data.hospital) ? data.hospital : [];
        const totalMarkers = data.walmart.length + data.linac.length + hospitalsRaw.length;

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

                // Attach source row so the sidebar can bucket by w.state (matches /api/metrics)
                // instead of doing client-side point-in-polygon (which disagreed on border / mislabeled rows).
                marker.walmartData = location;

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
                    flyMapTo(latLng, 12);
                });

                linacMarkers.push(marker);
            }
            loadedMarkers++;
            checkLoadingComplete(loadedMarkers, totalMarkers);
        });

        hospitalsRaw.forEach((hospital) => {
            const lat = parseFloat(String(hospital.LATITUDE));
            const lon = parseFloat(String(hospital.LONGITUDE));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                loadedMarkers++;
                checkLoadingComplete(loadedMarkers, totalMarkers);
                return;
            }
            const latLng = L.latLng(lat, lon);
            if (
                isValidUSCoordinate(lat, lon) &&
                (!usBoundaryLayer || usBoundaryLayer.getBounds().contains(latLng))
            ) {
                const marker = L.marker(latLng, {
                    icon: yellowMarkerIcon
                }).addTo(map);
                marker.hospitalData = hospital;
                marker.bindPopup(`
                    <strong>General acute or critical access hospital</strong><br>
                    ${hospital.NAME}<br>
                    ${hospital.CITY}, ${hospital.STATE}
                `);
                marker.on('click', function () {
                    flyMapTo(latLng, 12);
                });
                hospitalMarkers.push(marker);
            }
            loadedMarkers++;
            checkLoadingComplete(loadedMarkers, totalMarkers);
        });

        console.log(
            `[Map] Loaded from /api/map-data: ${data.walmart.length} Walmarts, ${data.linac.length} LINAC rows, general acute & critical access hospitals ${hospitalsRaw.length} (OPEN; markers inside US polygon + bbox)`
        );
        console.log(`Total LINAC Centers displayed on map (red markers): ${linacMarkers.length}`);
        console.log(`Total general acute & critical access hospitals displayed (yellow pins): ${hospitalMarkers.length}`);
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
    if (!overlay) {
        return;
    }
    overlay.classList.add('fade-out');
    // Remove the overlay from DOM after fade animation
    setTimeout(() => {
        overlay.remove();
    }, 300);
}

// Initialize event listeners
function initializeEventListeners() {
    const driveTimeSlider = document.getElementById('max-drive-minutes');
    const driveTimeValueLabel = document.getElementById('max-drive-minutes-value');
    const stateSelect = document.getElementById('state');
    const analyzeButton = document.getElementById('analyze');

    driveTimeSlider.addEventListener('input', async (e) => {
        const minutes = e.target.value;
        driveTimeValueLabel.textContent = minutes;
        console.log(`[Frontend] Max drive time changed to: ${minutes} min`);
        
        if (walmartsHidden) {
            updateLegend();
        }
        
        if (stateSelect.value && stateSelect.value !== 'all') {
            const selectedState = stateSelect.value;
            
            try {
                const q = `state=${encodeURIComponent(selectedState)}&driveTimeMinutes=${encodeURIComponent(minutes)}`;
                console.log(`[Frontend] Fetching metrics for ${q}`);
                const response = await fetch(`/api/metrics?${q}`);
                const metrics = await parseJsonOrThrow(response);
                console.log('[Frontend] Received metrics:', metrics);

                syncSystemicGapPinsFromMetrics(metrics);

                if (!document.getElementById('dashboard-modal').classList.contains('d-none')) {
                    document.getElementById('modal-dashboard-metrics').innerHTML = formatDashboardCardsHTML(
                        metrics,
                        minutes
                    );
                }
                
                if (document.getElementById('metrics-table-body')) {
                    createMetricsTable();
                }
            } catch (error) {
                console.error('Error updating metrics:', error);
                const modal = document.getElementById('dashboard-modal');
                const mEl = document.getElementById('modal-dashboard-metrics');
                if (mEl && modal && !modal.classList.contains('d-none')) {
                    const safe = String(error.message || error).replace(/</g, '&lt;');
                    mEl.innerHTML = `<div class="alert alert-danger m-3" role="alert">${safe}</div>`;
                }
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
        const minutes = getDriveTimeMinutes();
        
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
            const response = await fetch(
                `/api/metrics?state=${encodeURIComponent(selectedState)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );
            const metrics = await parseJsonOrThrow(response);

            document.getElementById('modal-dashboard-metrics').innerHTML = formatDashboardCardsHTML(
                metrics,
                minutes
            );
            syncSystemicGapPinsFromMetrics(metrics);
        } catch (error) {
            console.error('Error fetching metrics:', error);
            const safe = String(error.message || error).replace(/</g, '&lt;');
            document.getElementById('modal-dashboard-metrics').innerHTML = `
                <div class="alert alert-danger m-3" role="alert">${safe}</div>
            `;
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

    toggleWalmartsBtn.addEventListener('click', async () => {
        console.log('Toggle button clicked!'); // Log when clicked
        const isHiding = toggleWalmartsBtn.textContent === 'Hide Walmarts';
        console.log('isHiding:', isHiding); // Log the state
        const selectedState = document.getElementById('state').value;
        console.log('selectedState:', selectedState); // Log selected state
        
        // Allow toggling for US view or when a specific state is selected
        if (selectedState === 'US' || (selectedState && selectedState !== 'all')) {
            console.log('Condition met, proceeding with toggle'); // Log if condition is met
            if (isHiding) {
                await hideWalmartsNearLinac();
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
    walmartMarkers.forEach((marker) => marker.remove());
    linacMarkers.forEach((marker) => marker.remove());
    hospitalMarkers.forEach((marker) => marker.remove());
    clearSystemicGapMarkers();
    walmartMarkers = [];
    linacMarkers = [];
    hospitalMarkers = [];
}

// Update map markers
function updateMapMarkers(data) {
    const selectedCity = document.getElementById('city').value;

    if (selectedCity && selectedCity !== 'all' && data.cityCenter.length > 0) {
        const selectedLocation = data.cityCenter[0];

        console.log('Selected city center:', selectedLocation);

        const lonRaw = selectedLocation.Longitude != null ? selectedLocation.Longitude : selectedLocation.Longtitude;
        if (!selectedLocation.Latitude || lonRaw == null) {
            console.error('Invalid city center coordinates:', selectedLocation);
            return;
        }

        const lat = parseFloat(selectedLocation.Latitude);
        const lng = parseFloat(lonRaw);
        map.setView([lat, lng], 10);
    }
}

// Update displayMetrics function
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
        const minutes = getDriveTimeMinutes();
        modalMetricsContainer.innerHTML = formatDashboardCardsHTML(metrics, minutes);
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
        const minutes = getDriveTimeMinutes();
        const state = document.getElementById('state').value;
        
        const response = await fetch(
            `/api/metrics?state=${encodeURIComponent(state)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
        );
        const metrics = await parseJsonOrThrow(response);

        displayMetrics(metrics);
    } catch (error) {
        console.error('Error updating metrics:', error);
        const mEl = document.getElementById('modal-dashboard-metrics');
        if (mEl) {
            const safe = String(error.message || error).replace(/</g, '&lt;');
            mEl.innerHTML = `<div class="alert alert-danger m-3" role="alert">${safe}</div>`;
        }
    }
}

// Update map data
async function updateMapData() {
    try {
        const minutes = getDriveTimeMinutes();
        const city = document.getElementById('city').value;
        
        const response = await fetch(`/api/map-data?driveTimeMinutes=${encodeURIComponent(minutes)}&city=${city}`);
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

        // Markers are already loaded in initializeMap → loadInitialMarkers(); do not call again here
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
        osrmLinacGapPinKeys = null;
        const toggleWalmartsBtn = document.getElementById('toggle-walmarts');
        toggleWalmartsBtn.textContent = 'Hide Walmarts';
        updateLegend(); // Update legend to show "Walmart Locations"

        // Show the "Dashboard" button
        document.getElementById('dashboard-button').classList.remove('d-none');
        // Show the location toggle buttons
        document.getElementById('location-toggle-container').classList.remove('d-none');
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
        hospitalMarkers.forEach((marker) => {
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
            hospitalMarkers.forEach((m) => m.setOpacity(1));

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
            const minutes = getDriveTimeMinutes();
            const metricsResponse = await fetch(
                `/api/metrics?state=US&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );
            const metrics = await parseJsonOrThrow(metricsResponse);

            displayMetrics(metrics);
            syncSystemicGapPinsFromMetrics(metrics);
        } else {
            // Load state boundary and wait for result
            const boundaryLoaded = await loadStateBoundary(state);
            
            if (!boundaryLoaded || !stateLayer) {
                throw new Error('Failed to load state boundary');
            }

            // Show all markers, regardless of state boundaries
            walmartMarkers.forEach(marker => marker.setOpacity(1));
            linacMarkers.forEach(marker => marker.setOpacity(1));
            hospitalMarkers.forEach((m) => m.setOpacity(1));

            // Get state metrics from server
            const minutes = getDriveTimeMinutes();
            const response = await fetch(
                `/api/metrics?state=${encodeURIComponent(state)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );
            const metrics = await parseJsonOrThrow(response);

            displayMetrics(metrics);
            syncSystemicGapPinsFromMetrics(metrics);
        }

        updateLocationList();
        hideLoading();
    } catch (error) {
        console.error('Error updating analysis:', error);
        hideLoading();
    }
}

// Update the location list function to only show visible Walmart markers
function updateLocationList() {
    const listContainer = document.getElementById('location-list');
    const showWalmart = document.getElementById('walmart-toggle').checked;
    const selectedState = document.getElementById('state').value;

    listContainer.innerHTML = '';
    let locationsFound = 0;
    
    if (showWalmart) {
        walmartMarkers.forEach(marker => {
            // Bucket by the store's declared state field — matches /api/metrics. Previously used
            // point-in-polygon, which silently disagreed with the dashboard on border / mislabeled rows.
            // A ring-covered Walmart is suppressed on the map but still belongs in the sidebar list
            // — its identity isn't lost, it's just visualized as a systemic-gap ring.
            const isVisuallyPresent = marker.options.opacity !== 0 || marker._hiddenBySystemicGap;
            let shouldShow = false;

            if (selectedState === 'US') {
                shouldShow = isVisuallyPresent;
            } else {
                shouldShow = marker.walmartData && marker.walmartData.state === selectedState && isVisuallyPresent;
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
                    flyMapTo(location, 12);
                    marker.openPopup();
                });
                
                listContainer.appendChild(div);
                locationsFound++;
            }
        });
    } else {
        linacMarkers.forEach(marker => {
            // Bucket by the center's States field — matches /api/metrics inventory counts.
            // Previously used point-in-polygon, which disagreed for mislabeled / border rows.
            let shouldShow = false;

            if (selectedState === 'US') {
                shouldShow = true;
            } else {
                shouldShow = marker.linacData && marker.linacData.States === selectedState;
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
                    flyMapTo(location, 12);
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

// Initialize the application
async function initializeApp() {
    // The loading overlay is already visible from the HTML
    await initializeMap();
    initializeEventListeners();
    
    // Ensure dashboard button and location toggle are hidden on initial load
    document.getElementById('dashboard-button').classList.add('d-none');
    document.getElementById('location-toggle-container').classList.add('d-none');
    
    await populateStateDropdown();
}

// Call initialization when the page loads
document.addEventListener('DOMContentLoaded', initializeApp);

async function hideWalmartsNearLinac() {
    const selectedState = document.getElementById('state')?.value;
    if (!selectedState || selectedState === 'all') {
        return;
    }

    let gapKeys = osrmLinacGapPinKeys;
    if (gapKeys == null) {
        const minutes = getDriveTimeMinutes();
        const response = await fetch(
            `/api/metrics?state=${encodeURIComponent(selectedState)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
        );
        const metrics = await parseJsonOrThrow(response);
        gapKeys = setOsrmLinacGapPinsFromMetrics(metrics);
        syncSystemicGapPinsFromMetrics(metrics);
    }

    const { hiddenCount, visibleGapCount } = applyOsrmLinacGapVisibility(gapKeys, selectedState);
    console.log(
        `[Map] Hide Walmarts (OSRM): ${visibleGapCount} LINAC-gap pin(s) visible, ${hiddenCount} hidden`
    );
    updateLocationList();
}

// Update showAllWalmarts to show all markers
function showAllWalmarts() {
    console.log('Starting showAllWalmarts...');
    console.log(`Total Walmart markers to show: ${walmartMarkers.length}`);
    
    let processedCount = 0;
    
    // Show all Walmart markers — but keep ring-covered ones hidden (the purple ring is the
    // authoritative symbol at those locations; we never want a stray blue pin inside a ring).
    walmartMarkers.forEach(marker => {
        if (marker._hiddenBySystemicGap) {
            processedCount++;
            return;
        }
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
    const minutes = getDriveTimeMinutes();
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
                                <th class="text-end">
                                    <div>No LINAC within ${minutes} min (OSRM)</div>
                                    <div class="small text-muted fw-normal mt-1 lh-sm">Incl. bordering states. Cross-border excludes AK, HI &amp; PR LINACs; those rows use in-state LINACs only.</div>
                                </th>
                                <th class="text-end">
                                    <div>Viable gap</div>
                                    <div class="small text-muted fw-normal mt-1 lh-sm">LINAC gap with general acute or critical access hospital within ${HOSPITAL_BACKSTOP_MINUTES} min.</div>
                                </th>
                                <th class="text-end">
                                    <div>Systemic gap</div>
                                    <div class="small text-muted fw-normal mt-1 lh-sm">LINAC gap, no general acute or critical access hospital within ${HOSPITAL_BACKSTOP_MINUTES} min.</div>
                                </th>
                                <th class="text-end">Total<br>Walmarts</th>
                                <th class="text-end">LINAC<br>Centers</th>
                                <th class="text-end">Total<br>LINACs</th>
                            </tr>
                        </thead>
                        <tbody id="metrics-table-body">
                            <tr>
                                <td colspan="7" class="text-center">
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
    const minutes = getDriveTimeMinutes();
    const table = document.querySelector('.metrics-table');
    let csvContent = `State,No LINAC Within ${minutes} Min (OSRM),Viable Gap (General acute or critical access hospital ${HOSPITAL_BACKSTOP_MINUTES} min),Systemic Gap (no hospital within ${HOSPITAL_BACKSTOP_MINUTES} min),Total Walmarts,LINAC Centers,Total LINACs\n`;

    // Get all table rows
    const rows = table.querySelectorAll('tbody tr');
    
    // Convert each row to CSV
    rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 7 || row.id === 'metrics-table-loading-banner') {
            return;
        }
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
    link.setAttribute('download', `linac-walmart-metrics-${minutes}min-osrm.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Add new function to handle JSON download
function downloadMetricsJSON() {
    const minutes = getDriveTimeMinutes();
    const table = document.querySelector('.metrics-table');
    const rows = table.querySelectorAll('tbody tr');
    const jsonData = [];
    
    // Convert each row to a JSON object
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 7 || row.id === 'metrics-table-loading-banner') {
            return;
        }
        const state = cells[0].textContent.trim();
        const walmartsOutsideRange = parseInt(cells[1].textContent.replace(/,/g, '')) || 0;
        const viableGapWalmarts = parseInt(cells[2].textContent.replace(/,/g, '')) || 0;
        const systemicGapWalmarts = parseInt(cells[3].textContent.replace(/,/g, '')) || 0;
        const totalWalmarts = parseInt(cells[4].textContent.replace(/,/g, '')) || 0;
        const linacCenters = parseInt(cells[5].textContent.replace(/,/g, '')) || 0;
        const totalLinacs = parseInt(cells[6].textContent.replace(/,/g, '')) || 0;

        jsonData.push({
            state,
            walmartsOutsideRange,
            viableGapWalmarts,
            systemicGapWalmarts,
            totalWalmarts,
            linacCenters,
            totalLinacs,
            driveTimeMinutes: parseInt(minutes, 10),
            hospitalBackstopMinutes: HOSPITAL_BACKSTOP_MINUTES
        });
    });
    
    // Create and trigger download
    const jsonString = JSON.stringify(jsonData, null, 2); // Pretty print with 2 spaces
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `linac-walmart-metrics-${minutes}min-osrm.json`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function metricsTableLoadingRow(doneStates, totalStates) {
    return `
            <tr id="metrics-table-loading-banner">
                <td colspan="7" class="text-center py-2 text-muted bg-light border-bottom">
                    <div class="d-flex justify-content-center align-items-center gap-2 flex-wrap py-2">
                        <div class="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true"></div>
                        <span>Loading state metrics (${doneStates} / ${totalStates})...</span>
                    </div>
                </td>
            </tr>`;
}

function sumMetricsTotals(metricsList) {
    return metricsList.reduce(
        (acc, m) => ({
            walmartsOutsideRange: acc.walmartsOutsideRange + (m.walmartsOutsideRange || 0),
            viableGapWalmarts: acc.viableGapWalmarts + (m.viableGapWalmarts || 0),
            systemicGapWalmarts: acc.systemicGapWalmarts + (m.systemicGapWalmarts || 0),
            totalWalmarts: acc.totalWalmarts + (m.totalWalmarts || 0),
            cityCentersWithinRange: acc.cityCentersWithinRange + (m.cityCentersWithinRange || 0),
            linacsWithinRange: acc.linacsWithinRange + (m.linacsWithinRange || 0),
            totalHospitals: acc.totalHospitals + (m.totalHospitals || 0)
        }),
        {
            walmartsOutsideRange: 0,
            viableGapWalmarts: 0,
            systemicGapWalmarts: 0,
            totalWalmarts: 0,
            cityCentersWithinRange: 0,
            linacsWithinRange: 0,
            totalHospitals: 0
        }
    );
}

function renderMetricsRow(st, metrics, isStrong) {
    const m = metrics;
    const a = isStrong ? '<strong>' : '';
    const z = isStrong ? '</strong>' : '';
    return `
        <tr${isStrong ? ' class="us-total-row"' : ''}>
            <td>${a}${st}${z}</td>
            <td class="text-end">${a}${(m.walmartsOutsideRange || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.viableGapWalmarts || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.systemicGapWalmarts || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.totalWalmarts || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.cityCentersWithinRange || 0).toLocaleString()}${z}</td>
            <td class="text-end">${a}${(m.linacsWithinRange || 0).toLocaleString()}${z}</td>
        </tr>
    `;
}

// Metrics table rows use /api/metrics (OSRM Table on server) — same logic as dashboard, not client Haversine.
async function populateTableData() {
    const tableBody = document.getElementById('metrics-table-body');
    const minutes = getDriveTimeMinutes();
    const CONCURRENCY = 3;

    try {
        const inventoryRes = await fetchWithCacheBusting('/api/hospital-inventory');
        const inventory = inventoryRes.ok ? await inventoryRes.json() : { total: 0, byState: {} };
        const inventoryByState = inventory.byState || {};

        const states = Array.from(document.getElementById('state').options)
            .map((option) => ({ value: option.value, text: option.text }))
            .filter((option) => option.value !== 'all' && option.value !== 'US' && option.value !== '')
            .sort((a, b) => a.text.localeCompare(b.text));

        for (const code of Object.keys(inventoryByState)) {
            if (!states.some((s) => s.value === code)) {
                states.push({ value: code, text: stateNames[code] || code });
            }
        }
        states.sort((a, b) => a.text.localeCompare(b.text));

        const fetchMetrics = (stateCode) =>
            fetchWithCacheBusting(
                `/api/metrics?state=${encodeURIComponent(stateCode)}&driveTimeMinutes=${encodeURIComponent(minutes)}`
            );

        console.log(`[Table] OSRM reachability per state (${minutes} min; cross-border contiguous, AK/HI/PR isolated). US row = sum.`);

        let tableRows = '';
        /** @type {{ walmartsOutsideRange: number, viableGapWalmarts?: number, systemicGapWalmarts?: number, totalWalmarts: number, cityCentersWithinRange: number, linacsWithinRange: number, totalHospitals?: number }[]} */
        const metricsForTotals = [];

        tableBody.innerHTML = metricsTableLoadingRow(0, states.length);

        let doneStates = 0;
        const totalStates = states.length;
        for (let i = 0; i < states.length; i += CONCURRENCY) {
            const slice = states.slice(i, i + CONCURRENCY);
            const batch = await Promise.all(
                slice.map(async (s) => ({
                    state: s,
                    metrics: await fetchMetrics(s.value)
                }))
            );
            doneStates += batch.length;
            for (const { state: st, metrics: m } of batch) {
                tableRows += renderMetricsRow(st.text, m, false);
                metricsForTotals.push(m);
            }

            tableBody.innerHTML =
                metricsTableLoadingRow(doneStates, totalStates) +
                tableRows;
        }

        const usTotals = sumMetricsTotals(metricsForTotals);

        tableBody.innerHTML =
            renderMetricsRow('United States (sum)', usTotals, true) + tableRows;

        const sample = metricsForTotals[0];
        if (sample && !('viableGapWalmarts' in sample)) {
            console.warn(
                '[Table] /api/metrics response missing viableGapWalmarts — restart Node with latest server.js (old process omits gap split). Hard-refresh browser (Ctrl+F5).'
            );
        }

        console.log('[Table] Metrics table ready (US row summed from states).');
    } catch (error) {
        console.error('Error loading table metrics:', error);
        tableBody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center text-danger">
                    Error loading metrics: ${error.message}
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
    const hospitalLegend = `
            <div>
                <img src="/images/markers/marker-icon-yellow.png" alt="Hospital">
                General acute &amp; critical access hospitals
            </div>`;
    const systemicLegend = `
            <div>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style="flex-shrink:0">
                    <circle cx="7" cy="7" r="5.5" fill="#e1bee7" stroke="#4a148c" stroke-width="2"/>
                </svg>
                Systemic gap (OSRM)
            </div>`;
    const tail = `${hospitalLegend}${systemicLegend}`;
    if (walmartsHidden) {
        return `
            <div>
                <img src="/images/markers/marker-icon-blue.png" alt="Walmart">
                Linac gaps<sup style="left: -7px;">a</sup>
            </div>
            <div>
                <img src="/images/markers/marker-icon-red.png" alt="LINAC">
                LINAC Centers
            </div>
            ${tail}
        `;
    }
    return `
            <div>
                <img src="/images/markers/marker-icon-blue.png" alt="Walmart">
                Walmart Locations
            </div>
            <div>
                <img src="/images/markers/marker-icon-red.png" alt="LINAC">
                LINAC Centers
            </div>
            ${tail}
        `;
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