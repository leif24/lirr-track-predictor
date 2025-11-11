const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;

// --- Core TrainTime API logic ---
async function getTrainTimeData() {
  const url = 'https://traintime.lirr.org/api/TrainTime?station=Penn%20Station';
  const response = await fetch(url);
  if (!response.ok) throw new Error('TrainTime fetch failed');
  const data = await response.json();

  // Normalize relevant fields
  return data.Trains.map(t => ({
    destination: t.Destination?.trim(),
    trainNum: t.TrainNumber,
    track: t.Track && t.Track !== 'TBD' ? t.Track : null,
    status: t.Status,
    time: t.ScheduledTime,
  }));
}

// --- /api/predict endpoint ---
app.get('/api/predict', async (req, res) => {
  const { destination, trainNum } = req.query;
  if (!destination) {
    return res.status(400).json({ error: 'Missing destination parameter' });
  }

  try {
    const trains = await getTrainTimeData();
    const matches = trains.filter(
      t =>
        t.destination?.toLowerCase().includes(destination.toLowerCase()) ||
        (trainNum && t.trainNum?.toString() === trainNum)
    );

    if (matches.length === 0) {
      return res.json({
        destination,
        trainNum,
        predictions: [],
      });
    }

    const preds = matches.map(t => ({
      method: 'realtime',
      track: t.track,
      confidence: t.track ? 95 : 50,
      reason: t.track
        ? 'Live track assignment from LIRR TrainTime API'
        : 'Track not yet posted (TBD)',
    }));

    res.json({
      destination,
      trainNum,
      predictions: preds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch track data' });
  }
});

// --- /api/stats endpoint (dummy health info) ---
app.get('/api/stats', async (req, res) => {
  try {
    const trains = await getTrainTimeData();
    res.json({
      totalTrains: trains.length,
      lastUpdate: new Date().toISOString(),
      totalPatterns: 0,
      successfulFetches: 1,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// --- Health check ---
app.get('/health', (req, res) => res.send('OK'));

// --- Serve frontend if deployed together ---
app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoint: http://localhost:${PORT}/api/predict?destination=Babylon`);
});
