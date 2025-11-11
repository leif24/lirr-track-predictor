const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// Enable CORS
app.use(cors());
app.use(express.json());

// LIRR TrainTime API endpoint (no API key needed!)
const TRAINTIME_API = 'https://traintime.lirr.org/api/Departure?loc=NYK';

// In-memory storage
const memoryStorage = new Map();

// Storage stats
const storageStats = {
  successfulFetches: 0,
  failedFetches: 0,
  lastUpdate: null
};

// Destination mapping
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

// Seed data: Known common patterns
const SEED_PATTERNS = {
  'Babylon': { tracks: [13, 15, 17], confidence: 35 },
  'Far Rockaway': { tracks: [3, 5], confidence: 35 },
  'Hempstead': { tracks: [11, 13, 15], confidence: 35 },
  'Long Beach': { tracks: [1, 3, 5], confidence: 35 },
  'West Hempstead': { tracks: [11, 13, 15], confidence: 35 },
  'Oyster Bay': { tracks: [17, 19], confidence: 35 },
  'Port Jefferson': { tracks: [17, 19, 21], confidence: 35 },
  'Ronkonkoma': { tracks: [13, 15, 17], confidence: 35 },
  'Greenport': { tracks: [21], confidence: 35 },
  'Port Washington': { tracks: [17, 19, 21], confidence: 35 },
  'Huntington': { tracks: [17, 19], confidence: 35 },
  'Montauk': { tracks: [13, 15], confidence: 35 }
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidTrack(track) {
  const trackNum = parseInt(track);
  return trackNum >= 1 && trackNum <= 21;
}

async function setStorage(key, value) {
  try {
    memoryStorage.set(key, value);
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

async function fetchTrainTimeData() {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Fetching TrainTime API (attempt ${attempt + 1}/${maxRetries})...`);
      
      const response = await fetch(TRAINTIME_API);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data;
      
    } catch (error) {
      console.error(`Fetch attempt ${attempt + 1} failed:`, error.message);
      
      if (attempt === maxRetries - 1) {
        storageStats.failedFetches++;
        return null;
      }
      
      const backoffMs = 1000 * Math.pow(2, attempt);
      console.log(`Retrying in ${backoffMs}ms...`);
      await sleep(backoffMs);
    }
  }
  
  return null;
}

function parseTrainTimeData(data) {
  const trackAssignments = [];
  
  if (!data || !data.TRAINS) {
    console.log('No TRAINS data in response');
    return trackAssignments;
  }
  
  console.log(`\n=== TRAINTIME API DEBUG ===`);
  console.log(`Total trains: ${data.TRAINS.length}`);
  
  let trainsWithTracks = 0;
  
  for (const train of data.TRAINS) {
    const destination = train.DEST;
    const track = train.TRACK;
    const trainNum = train.TRAIN_ID;
    const scheduledTime = train.SCHED;
    
    // Only process if track is assigned
    if (!track || track === '*' || track === '') continue;
    
    // Validate track number
    if (!isValidTrack(track)) {
      console.log(`⚠️  Invalid track: ${track} for ${destination}`);
      continue;
    }
    
    trainsWithTracks++;
    console.log(`✅ ${destination} → Track ${track} (Train ${trainNum})`);
    
    trackAssignments.push({
      destination,
      track,
      trainNum,
      scheduledTime,
      timestamp: new Date()
    });
  }
  
  console.log(`Trains with tracks assigned: ${trainsWithTracks}`);
  console.log(`=== END DEBUG ===\n`);
  
  return trackAssignments;
}

async function learnFromAssignments(assignments) {
  if (assignments.length === 0) return;
  
  const patterns = await getStorage('patterns') || {};
  
  for (const assignment of assignments) {
    const { destination, track, trainNum, timestamp } = assignment;
    
    if (!patterns[destination]) {
      patterns[destination] = {};
    }
    
    // Store by train number
    if (trainNum) {
      if (!patterns[destination][trainNum]) {
        patterns[destination][trainNum] = [];
      }
      
      patterns[destination][trainNum].push({
        track,
        timestamp: timestamp.toISOString(),
        hour: timestamp.getHours()
      });
      
      // Keep only last 100 observations per train
      if (patterns[destination][trainNum].length > 100) {
        patterns[destination][trainNum] = patterns[destination][trainNum].slice(-100);
      }
    }
    
    // Store general destination patterns
    if (!patterns[destination]['_general']) {
      patterns[destination]['_general'] = [];
    }
    
    patterns[destination]['_general'].push({
      track,
      timestamp: timestamp.toISOString(),
      trainNum
    });
    
    // Keep only last 500 observations per destination
    if (patterns[destination]['_general'].length > 500) {
      patterns[destination]['_general'] = patterns[destination]['_general'].slice(-500);
    }
  }
  
  await setStorage('patterns', patterns);
  console.log(`Learned ${assignments.length} new patterns`);
}

function getPredictions(destination, trainNum = null) {
  const patterns = memoryStorage.get('patterns') || {};
  const predictions = [];
  
  const destPattern = patterns[destination];
  
  if (!destPattern) {
    // Return seed data only
    const seedData = SEED_PATTERNS[destination];
    if (seedData) {
      predictions.push({
        method: 'branch_pattern',
        tracks: seedData.tracks,
        confidence: seedData.confidence,
        reason: `${destination} trains typically use tracks: ${seedData.tracks.join(', ')}`
      });
    }
    return predictions;
  }
  
  // If train number specified, check for historical pattern
  if (trainNum && destPattern[trainNum]) {
    const trainHistory = destPattern[trainNum];
    const trackCounts = {};
    
    for (const observation of trainHistory) {
      trackCounts[observation.track] = (trackCounts[observation.track] || 0) + 1;
    }
    
    const sortedTracks = Object.entries(trackCounts)
      .sort((a, b) => b[1] - a[1]);
    
    if (sortedTracks.length > 0) {
      const [topTrack, count] = sortedTracks[0];
      const confidence = Math.min(95, Math.round((count / trainHistory.length) * 100));
      
      predictions.push({
        method: 'historical_pattern',
        track: topTrack,
        confidence,
        reason: `Train #${trainNum} has used Track ${topTrack} in ${count} of ${trainHistory.length} recent observations`,
        alternatives: sortedTracks.slice(1, 3).map(([track]) => track)
      });
    }
  }
  
  // General destination patterns
  if (destPattern['_general']) {
    const generalHistory = destPattern['_general'];
    const trackCounts = {};
    
    const recentObservations = generalHistory.slice(-50);
    for (const observation of recentObservations) {
      trackCounts[observation.track] = (trackCounts[observation.track] || 0) + 1;
    }
    
    const sortedTracks = Object.entries(trackCounts)
      .sort((a, b) => b[1] - a[1]);
    
    if (sortedTracks.length > 0) {
      const topTracks = sortedTracks.slice(0, 3).map(([track]) => track);
      const [topTrack, count] = sortedTracks[0];
      const confidence = Math.min(85, Math.round((count / recentObservations.length) * 100));
      
      predictions.push({
        method: 'destination_pattern',
        track: topTrack,
        confidence,
        reason: `${destination} trains recently used Track ${topTrack} most often (${count}/${recentObservations.length} times)`,
        alternatives: sortedTracks.slice(1, 3).map(([track]) => track)
      });
    }
  }
  
  // Add seed data as fallback
  const seedData = SEED_PATTERNS[destination];
  if (seedData && predictions.length === 0) {
    predictions.push({
      method: 'branch_pattern',
      tracks: seedData.tracks,
      confidence: seedData.confidence,
      reason: `${destination} trains typically use tracks: ${seedData.tracks.join(', ')}`
    });
  }
  
  predictions.sort((a, b) => b.confidence - a.confidence);
  
  return predictions;
}

async function startLearningService() {
  console.log('Starting LIRR Track Predictor learning service...');
  
  async function fetchAndLearn() {
    try {
      const data = await fetchTrainTimeData();
      
      if (data) {
        const assignments = parseTrainTimeData(data);
        console.log(`Found ${assignments.length} track assignments`);
        
        if (assignments.length > 0) {
          await learnFromAssignments(assignments);
          storageStats.successfulFetches++;
          storageStats.lastUpdate = new Date().toISOString();
        }
        
        const patterns = await getStorage('patterns') || {};
        const totalPatterns = Object.keys(patterns).reduce((sum, dest) => {
          return sum + Object.keys(patterns[dest]).length;
        }, 0);
        
        console.log(`Stats: ${totalPatterns} patterns, ${storageStats.successfulFetches} successful fetches`);
      }
    } catch (error) {
      console.error('Error in learning loop:', error);
    }
  }
  
  await fetchAndLearn();
  setInterval(fetchAndLearn, 30000);
}

// API Routes
app.get('/health', async (req, res) => {
  const patterns = await getStorage('patterns') || {};
  const totalPatterns = Object.keys(patterns).reduce((sum, dest) => {
    return sum + Object.keys(patterns[dest]).length;
  }, 0);
  
  const isHealthy = storageStats.lastUpdate && 
    (Date.now() - new Date(storageStats.lastUpdate).getTime() < 300000);
  
  res.json({
    status: isHealthy ? 'healthy' : 'stale',
    totalPatterns,
    lastUpdate: storageStats.lastUpdate,
    successfulFetches: storageStats.successfulFetches,
    failedFetches: storageStats.failedFetches,
    uptime: process.uptime(),
    isHealthy
  });
});

app.get('/api/stats', async (req, res) => {
  const patterns = await getStorage('patterns') || {};
  const totalPatterns = Object.keys(patterns).reduce((sum, dest) => {
    return sum + Object.keys(patterns[dest]).length;
  }, 0);
  
  res.json({
    totalPatterns,
    lastUpdate: storageStats.lastUpdate,
    successfulFetches: storageStats.successfulFetches,
    failedFetches: storageStats.failedFetches,
    destinations: Object.keys(patterns)
  });
});

app.get('/api/predict', async (req, res) => {
  const { destination, trainNum } = req.query;
  
  if (!destination) {
    return res.status(400).json({ error: 'Destination parameter required' });
  }
  
  const predictions = getPredictions(destination, trainNum);
  
  res.json({
    destination,
    trainNum: trainNum || null,
    predictions,
    generatedAt: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoint: http://localhost:${PORT}/api/predict?destination=Babylon&trainNum=2739`);
  
  startLearningService();
});
