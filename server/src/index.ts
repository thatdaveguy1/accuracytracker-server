
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { initDB } from './db';
import * as weatherService from './services/weatherService';
import * as statsService from './services/statsService';
import db from './db';

const app = express();
const PORT = process.env.PORT || 3001;

import path from 'path';

app.use(cors());
app.use(express.json());

// Serve Static Files (Client Build)
console.log('[DEBUG] CWD:', process.cwd());
console.log('[DEBUG] __dirname:', __dirname);
const clientBuildPath = path.join(process.cwd(), 'dist');
console.log('[DEBUG] clientBuildPath:', clientBuildPath);
app.use(express.static(clientBuildPath));

// Initialize Database
initDB();

// --- API Routes ---

app.get('/api/current-conditions', (req, res) => {
    try {
        const obs = statsService.getLatestObservation();
        res.json(obs);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/history', (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 24;
        const obs = statsService.getRecentObservations(limit);
        res.json(obs);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/leaderboard', (req, res) => {
    try {
        const bucket = (req.query.bucket as any) || '24h';
        const variable = (req.query.variable as string) || 'overall_score';
        const leaderboard = statsService.getLeaderboard(bucket, variable);
        res.json(leaderboard);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/model/:id', (req, res) => {
    try {
        const stats = statsService.getModelDetails(req.params.id);
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/status', (req, res) => {
    try {
        const lastFetch = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_forecast_fetch') as { value: string } | undefined;
        res.json({
            status: 'online',
            last_fetch: lastFetch ? parseInt(lastFetch.value) : null,
            server_time: Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/taf', async (req, res) => {
    try {
        const taf = await weatherService.fetchTAF();
        res.json({ taf });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/trigger-update', async (req, res) => {
    try {
        console.log('[MANUAL] Triggering update...');
        // Run in background to avoid timeout
        runUpdateCycle().catch(err => console.error('[MANUAL] Update failed:', err));
        res.json({ message: 'Update cycle started' });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/reset', (req, res) => {
    try {
        console.log('[MANUAL] Resetting database...');
        db.exec('DELETE FROM forecasts');
        db.exec('DELETE FROM observations');
        db.exec('DELETE FROM verifications');
        db.exec('DELETE FROM metadata');
        console.log('[MANUAL] Database cleared.');
        res.json({ message: 'Database reset successfully' });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// --- Update Cycle ---

let isUpdating = false;

async function runUpdateCycle() {
    if (isUpdating) {
        console.log('[UPDATE] Cycle already running, skipping.');
        return;
    }
    isUpdating = true;
    try {
        console.log('[UPDATE] Starting hourly update cycle...');
        await weatherService.fetchMETARHistory();
        await weatherService.fetchAllModels();
        await weatherService.runVerification();
        await weatherService.runVerification();

        // NEW: Aggregate stats for today (and yesterday to be safe)
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        statsService.aggregateDailyStats(yesterday);
        statsService.aggregateDailyStats(today);

        statsService.refreshLeaderboardCache();
        console.log('[UPDATE] Cycle complete.');
    } catch (e) {
        console.error('[UPDATE] Cycle failed:', e);
    } finally {
        isUpdating = false;
    }
}

// --- Scheduler ---

// Run every hour at minute 5 (e.g. 12:05, 13:05) to allow data to settle
cron.schedule('5 * * * *', () => {
    runUpdateCycle();
});

// --- Admin Routes ---

app.post('/api/admin/backfill', (req, res) => {
    console.log('[ADMIN] Triggering backfill...');
    statsService.backfillStats().catch(err => console.error('[BACKFILL] Failed:', err));
    res.json({ message: 'Backfill started in background' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
});

// Catch-all for SPA (must be last)
app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
});
