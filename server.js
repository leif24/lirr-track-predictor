const express = require('express');
const cors = require('cors');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// LIRR GTFS-RT Feed URL
const MTA_FEED_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr';
const POLL_INTERVAL = 30000; // 30 seconds
const STALE_THRESHOLD = 300000; // 5 minutes

// Route ID to destination mapping
const DESTINATIONS = {
  '1': 'Babylon',
  '2': 'Far Rockaway',
  '3': 'Hempstead',
  '4': 'Long Beach',
  '5': 'West Hempstead',
  '6': 'Oyster Bay',
  '7': 'Port Jefferson',
  '8': 'Ronkonkoma',
  '9': 'Greenport',
  '10': 'Port Washington',
  '11': 'Huntington',
  '12': 'Montauk'
};

// Seed patterns (fallback data with low confidence)
const SEED_PATTERNS = {
  'Babylon': [13, 15, 17],
  'Port Washington': [4, 6, 8],
  'Huntington': [9, 11, 13],
  'Ronkonkoma': [13, 15, 17, 19],
  'Hempstead': [1, 3, 5],
  'Far Rockaway': [1, 3, 5],
  'Port Jefferson': [9, 11, 13],
  'Long Beach': [1, 3, 5],
  'West Hempstead': [1, 3, 5],
  'Oyster Bay': [4, 6, 8],
  'Greenport': [9, 11],
  'Montauk': [13, 15, 17]
};

// In-memory storage (fallback if Claude storage unavailable)
let memoryStorage = new Map();
let storageStats = {
  totalPatterns: 0,
  lastUpdate: null,
  successfulFetches: 0,
  failedFetches: 0,
  isHealthy: true
};

// Middleware
app.use(cors());
app.use(express.json());

// Utility: Sleep function for retry backoff
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Utility: Validate track number
function isValidTrack(track) {
  const trackNum = parseInt(track);
  return trackNum >= 1 && trackNum <= 21;
}

// Utility: Extract track from stop_id (e.g., "NYK_13" -> "13")
function extractTrack(stopId) {
  if (!stopId) return null;
  
  // Try multiple patterns
  // Pattern 1: NYK_13, NY_13
  let match = stopId.match(/(?:NYK?|NY)_(\d+)/i);
  if (match && match[1]) {
    const track = match[1];
    if (isValidTrack(track)) return track;
  }
  
  // Pattern 2: Just the stop ID might be the track number
  match = stopId.match(/(\d+)$/);
  if (match && match[1]) {
    const track = match[1];
    if (isValidTrack(track)) return track;
  }
  
  // Pattern 3: Look for any number in the string
  match = stopId.match(/\d+/);
  if (match && match[0]) {
    const track = match[0];
    if (isValidTrack(track)) return track;
  }
  
  return null;
}

// Storage wrapper with fallback
async function setStorage(key, value) {
  try {
    memoryStorage.set(key, value);
    // In production, this would call Claude storage API
    // For now, using in-memory storage
    return true;
  } catch (error) {
    console.error('Storage error:', error);
    return false;
  }
}

async function getStorage(key) {
  try {
    return memoryStorage.get(key) || null;
  } catch (error) {
    console.error('Storage error:', error);
    return null;
  }
}

// Fetch MTA data with retry logic
async function fetchMTAData() {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Fetching MTA feed (attempt ${attempt + 1}/${maxRetries})...`);
      
      const response = await fetch(MTA_FEED_URL);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer);
      
    } catch (error) {
      console.error(`Fetch attempt ${attempt + 1} failed:`, error.message);
      
      if (attempt === maxRetries - 1) {
        storageStats.failedFetches++;
        return null;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = 1000 * Math.pow(2, attempt);
      console.log(`Retrying in ${backoffMs}ms...`);
      await sleep(backoffMs);
    }
  }
  
  return null;
}

// Parse GTFS-RT feed and extract track assignments
function parseFeed(buffer) {
  try {
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
    const trackAssignments = [];
    
    // DEBUG: Log feed info
    console.log(`\n=== FEED DEBUG ===`);
    console.log(`Total entities in feed: ${feed.entity.length}`);
    
    let tripUpdateCount = 0;
    let stopsWithPlatform = 0;
    const allStopIds = new Set();
    const allRouteIds = new Set();
    const stopExamples = [];
    
    for (const entity of feed.entity) {
      if (!entity.tripUpdate) continue;
      tripUpdateCount++;
      
      const trip = entity.tripUpdate.trip;
      const stopTimeUpdates = entity.tripUpdate.stopTimeUpdate || [];
      
      // Get route (destination)
      const routeId = trip.routeId;
      if (routeId) allRouteIds.add(routeId);
      const destination = DESTINATIONS[routeId];
      
      // Extract train number from trip_id
      const trainNum = trip.tripId?.split('_')[0] || null;
      
      // Check ALL stops for track/platform info
      for (const stop of stopTimeUpdates) {
        const stopId = stop.stopId;
        if (stopId) allStopIds.add(stopId);
        
        // Look for platform code (this might be the track!)
        const platformCode = stop.platformCode;
        
        // Save examples of stops with platform codes
        if (platformCode && stopExamples.length < 5) {
          stopExamples.push({
            stopId,
            platformCode,
            routeId,
            destination
          });
        }
        
        if (platformCode) {
          stopsWithPlatform++;
          
          // Check if platform code is a valid track (1-21)
          const track = platformCode.toString();
          if (isValidTrack(track)) {
            // Determine if arrival or departure
            const arrivalTime = stop.arrival?.time;
            const departureTime = stop.departure?.time;
            
            // Only include if we have a destination
            if (destination) {
              console.log(`✅ Found: Stop ${stopId}, Platform ${platformCode}, Route ${routeId} (${destination})`);
              
              trackAssignments.push({
                destination,
                track,
                trainNum,
                routeId,
                isArrival: !!arrivalTime && !departureTime,
                isDeparture: !!departureTime,
                timestamp: new Date((departureTime || arrivalTime) * 1000)
              });
            }
          }
        }
      }
    }
    
    console.log(`\nTrip updates: ${tripUpdateCount}`);
    console.log(`Stops with platform codes: ${stopsWithPlatform}`);
    console.log(`Sample stop IDs: ${Array.from(allStopIds).slice(0, 10).join(', ')}`);
    console.log(`Route IDs: ${Array.from(allRouteIds).join(', ')}`);
    console.log(`\nExample stops with platforms:`);
    stopExamples.forEach(ex => {
      console.log(`  Stop ${ex.stopId}: Platform "${ex.platformCode}" - ${ex.destination || 'Unknown'}`);
    });
    console.log(`Track assignments extracted: ${trackAssignments.length}`);
    console.log(`=== END DEBUG ===\n`);
    
    return trackAssignments;
    
  } catch (error) {
    console.error('Error parsing feed:', error);
    return [];
  }
}

// Store track pattern
async function storePattern(assignment) {
  try {
    const { destination, track, trainNum, timestamp } = assignment;
    
    const date = new Date(timestamp);
    const dayOfWeek = date.getDay(); // 0-6
    const hour = date.getHours(); // 0-23
    
    // Build storage key for specific train pattern
    const key = `track:${destination}:${dayOfWeek}:${hour}:${trainNum}`;
    
    // Get existing pattern
    let pattern = await getStorage(key);
    
    if (!pattern) {
      pattern = {
        tracks: {},
        mostCommon: track,
        confidence: 0,
        count: 0,
        alternatives: [],
        lastSeen: timestamp.toISOString()
      };
    }
    
    // Update track counts
    pattern.tracks[track] = (pattern.tracks[track] || 0) + 1;
    pattern.count++;
    pattern.lastSeen = timestamp.toISOString();
    
    // Calculate most common track
    const sortedTracks = Object.entries(pattern.tracks)
      .sort((a, b) => b[1] - a[1]);
    
    pattern.mostCommon = sortedTracks[0][0];
    
    // Calculate confidence based on consistency
    const maxCount = sortedTracks[0][1];
    pattern.confidence = Math.min(95, Math.round((maxCount / pattern.count) * 100));
    
    // Get alternatives (other tracks used more than once)
    pattern.alternatives = sortedTracks
      .slice(1)
      .filter(([_, count]) => count > 1)
      .map(([track]) => track);
    
    await setStorage(key, pattern);
    
    // Store recent arrival for inbound matching
    if (assignment.isArrival) {
      const arrivalKey = `arrival:${destination}:recent`;
      await setStorage(arrivalKey, {
        track,
        timestamp: timestamp.toISOString(),
        trainNum
      });
    }
    
    return true;
    
  } catch (error) {
    console.error('Error storing pattern:', error);
    return false;
  }
}

// Update learning statistics
async function updateStats() {
  try {
    storageStats.lastUpdate = new Date().toISOString();
    storageStats.isHealthy = Date.now() - new Date(storageStats.lastUpdate) < STALE_THRESHOLD;
    
    // Count total patterns
    let count = 0;
    for (const key of memoryStorage.keys()) {
      if (key.startsWith('track:')) count++;
    }
    storageStats.totalPatterns = count;
    
    await setStorage('stats:learning', storageStats);
    
  } catch (error) {
    console.error('Error updating stats:', error);
  }
}

// Main learning loop
async function learningLoop() {
  console.log('Starting LIRR Track Predictor learning service...');
  
  while (true) {
    try {
      const buffer = await fetchMTAData();
      
      if (buffer) {
        const assignments = parseFeed(buffer);
        console.log(`Found ${assignments.length} track assignments`);
        
        for (const assignment of assignments) {
          await storePattern(assignment);
        }
        
        storageStats.successfulFetches++;
        await updateStats();
        
        console.log(`Stats: ${storageStats.totalPatterns} patterns, ${storageStats.successfulFetches} successful fetches`);
      }
      
    } catch (error) {
      console.error('Error in learning loop:', error);
      storageStats.failedFetches++;
    }
    
    // Wait before next poll
    await sleep(POLL_INTERVAL);
  }
}

// API: Get prediction for a train
app.get('/api/predict', async (req, res) => {
  try {
    const { destination, trainNum } = req.query;
    
    if (!destination) {
      return res.status(400).json({ error: 'Destination required' });
    }
    
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    
    const predictions = [];
    
    // Method 1: Inbound matching (highest confidence)
    const arrivalKey = `arrival:${destination}:recent`;
    const recentArrival = await getStorage(arrivalKey);
    
    if (recentArrival) {
      const arrivalTime = new Date(recentArrival.timestamp);
      const minutesAgo = (now - arrivalTime) / 1000 / 60;
      
      // Only use if within 15 minutes
      if (minutesAgo <= 15) {
        predictions.push({
          method: 'inbound_match',
          track: recentArrival.track,
          confidence: 85,
          reason: `Train arrived on Track ${recentArrival.track} ${Math.round(minutesAgo)} min ago`
        });
      }
    }
    
    // Method 2: Historical pattern for specific train
    if (trainNum) {
      const key = `track:${destination}:${dayOfWeek}:${hour}:${trainNum}`;
      const pattern = await getStorage(key);
      
      if (pattern && pattern.count >= 2) {
        predictions.push({
          method: 'historical_pattern',
          track: pattern.mostCommon,
          confidence: pattern.confidence,
          alternatives: pattern.alternatives,
          reason: `Train #${trainNum} historically uses Track ${pattern.mostCommon} (${pattern.count} times observed)`
        });
      }
    }
    
    // Method 3: General branch patterns (seed data)
    if (SEED_PATTERNS[destination]) {
      predictions.push({
        method: 'branch_pattern',
        tracks: SEED_PATTERNS[destination],
        confidence: 35,
        reason: `${destination} trains typically use tracks: ${SEED_PATTERNS[destination].join(', ')}`
      });
    }
    
    // Return predictions sorted by confidence
    predictions.sort((a, b) => b.confidence - a.confidence);
    
    res.json({
      destination,
      trainNum: trainNum || null,
      predictions,
      timestamp: now.toISOString()
    });
    
  } catch (error) {
    console.error('Prediction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: Get current trains (all departures)
app.get('/api/trains', async (req, res) => {
  try {
    const buffer = await fetchMTAData();
    
    if (!buffer) {
      return res.status(503).json({ error: 'Unable to fetch MTA data' });
    }
    
    const assignments = parseFeed(buffer);
    const departures = assignments.filter(a => a.isDeparture);
    
    res.json({
      departures,
      count: departures.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching trains:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: Debug endpoint - see raw feed structure
app.get('/api/debug', async (req, res) => {
  try {
    const buffer = await fetchMTAData();
    
    if (!buffer) {
      return res.status(503).json({ error: 'Unable to fetch MTA data' });
    }
    
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
    
    // Sample first few entities to see structure
    const samples = feed.entity.slice(0, 5).map(entity => {
      if (!entity.tripUpdate) return null;
      
      const trip = entity.tripUpdate.trip;
      const stops = entity.tripUpdate.stopTimeUpdate || [];
      
      return {
        tripId: trip.tripId,
        routeId: trip.routeId,
        destination: DESTINATIONS[trip.routeId],
        stops: stops.map(stop => ({
          stopId: stop.stopId,
          stopName: stop.stopId,
          hasArrival: !!stop.arrival,
          hasDeparture: !!stop.departure
        }))
      };
    }).filter(Boolean);
    
    res.json({
      totalEntities: feed.entity.length,
      samples,
      message: 'This shows the structure of data in the MTA feed'
    });
    
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Health check
app.get('/health', async (req, res) => {
  const stats = await getStorage('stats:learning') || storageStats;
  
  const health = {
    status: stats.isHealthy ? 'healthy' : 'stale',
    ...stats,
    uptime: process.uptime()
  };
  
  res.json(health);
});

// API: Get learning statistics
app.get('/api/stats', async (req, res) => {
  const stats = await getStorage('stats:learning') || storageStats;
  res.json(stats);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoint: http://localhost:${PORT}/api/predict?destination=Babylon&trainNum=2739`);
  
  // Start learning loop in background
  learningLoop().catch(console.error);
});
