
import db from '../db';
import type { LeaderboardRow, ModelVariableStats, Observation, BucketName } from '../types';
import { MODELS, MIN_MAE_THRESHOLDS, MISSING_DATA_PENALTY_SCORE, LEAD_TIME_BUCKETS, FORECAST_VARIABLES, ALL_BUCKETS } from '../constants';

export function getLatestObservation(): Observation | null {
    const row = db.prepare('SELECT data FROM observations ORDER BY obs_time DESC LIMIT 1').get() as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data);
}

export function getRecentObservations(limit = 24): Observation[] {
    const rows = db.prepare('SELECT data FROM observations ORDER BY obs_time DESC LIMIT ?').all(limit) as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
}

// Internal calculation function (Heavy) - NOW DEPRECATED, used only for backfill/verification if needed
function calculateLeaderboardFromRaw(bucket: BucketName = '24h', variable: string = 'overall_score'): LeaderboardRow[] {
    const label = `[PERF] calculateLeaderboardFromRaw(${bucket}, ${variable})`;
    console.time(label);

    const [minHour, maxHour] = LEAD_TIME_BUCKETS[bucket];

    let query = `
        SELECT 
            model_id, 
            variable, 
            AVG(absolute_error) as mae, 
            AVG(squared_error) as mse, 
            AVG(bias) as bias,
            COUNT(DISTINCT valid_time) as n
        FROM verifications
        WHERE lead_time_hours >= ? AND lead_time_hours < ?
    `;

    const params: any[] = [minHour, maxHour];

    if (variable !== 'overall_score') {
        query += ` AND variable = ?`;
        params.push(variable);
    }

    query += ` GROUP BY model_id, variable`;

    console.time(`${label}:query`);
    const statsRows = db.prepare(query).all(...params) as { model_id: string, variable: string, mae: number, mse: number, bias: number, n: number }[];
    console.timeEnd(`${label}:query`);

    // 2. Aggregate into Leaderboard Rows
    const modelStats: Record<string, Partial<LeaderboardRow>> = {};
    const modelVarCounts: Record<string, number> = {};

    // Initialize
    MODELS.forEach(m => {
        modelStats[m.id] = {
            model: m.id,
            avg_mae: 0,
            avg_rmse: 0,
            avg_mse: 0,
            avg_bias: 0,
            total_verifications: 0
        };
        modelVarCounts[m.id] = 0;
    });
    // Add synthetic models
    ['average_of_models', 'median_of_models'].forEach(id => {
        modelStats[id] = {
            model: id,
            avg_mae: 0,
            avg_rmse: 0,
            avg_mse: 0,
            avg_bias: 0,
            total_verifications: 0
        };
        modelVarCounts[id] = 0;
    });

    statsRows.forEach(row => {
        if (!modelStats[row.model_id]) return;

        // Skip visibility for composite score ONLY if we are calculating overall_score
        if (variable === 'overall_score' && row.variable === 'visibility') return;

        // Normalize MAE
        const threshold = MIN_MAE_THRESHOLDS[row.variable] || MIN_MAE_THRESHOLDS['default'];
        const normalizedMae = row.mae / threshold;

        const s = modelStats[row.model_id]!;
        s.avg_mae = (s.avg_mae || 0) + normalizedMae;
        s.avg_mse = (s.avg_mse || 0) + row.mse;
        s.avg_bias = (s.avg_bias || 0) + Math.abs(row.bias);
        // Use MAX of N across variables, effectively counting "Forecast Hours" rather than "Data Points"
        s.total_verifications = Math.max((s.total_verifications || 0), row.n);

        modelVarCounts[row.model_id]++;
    });

    // Finalize averages
    const leaderboard: LeaderboardRow[] = [];
    Object.values(modelStats).forEach(row => {
        const count = modelVarCounts[row.model as string];
        if (count > 0) {
            leaderboard.push({
                model: row.model!,
                avg_mae: row.avg_mae! / count,
                avg_rmse: Math.sqrt(row.avg_mse! / count),
                avg_mse: row.avg_mse! / count,
                avg_bias: row.avg_bias! / count,
                avg_corr: null,
                avg_skill: null,
                std_error: null,
                total_verifications: row.total_verifications!
            });
        }
    });

    const result = leaderboard.sort((a, b) => a.avg_mae - b.avg_mae);
    console.timeEnd(label);
    return result;
}

// NEW: Aggregate stats for a single day (Chunked Processing)
export async function aggregateDailyStats(dateStr: string) {
    const label = `[AGG] Processing ${dateStr}`;
    console.time(label);

    const startTs = new Date(dateStr + 'T00:00:00Z').getTime();
    const endTs = new Date(dateStr + 'T23:59:59Z').getTime();

    // Iterate through all buckets
    for (const bucket of ALL_BUCKETS) {
        // Yield to event loop to prevent blocking
        await new Promise(resolve => setImmediate(resolve));

        const [minHour, maxHour] = LEAD_TIME_BUCKETS[bucket];

        // Aggregate raw verifications for this day & bucket
        const rows = db.prepare(`
            SELECT 
                model_id,
                variable,
                SUM(absolute_error) as mae_sum,
                SUM(squared_error) as mse_sum,
                SUM(bias) as bias_sum,
                COUNT(*) as count
            FROM verifications
            WHERE valid_time >= ? AND valid_time <= ?
            AND lead_time_hours >= ? AND lead_time_hours < ?
            GROUP BY model_id, variable
        `).all(startTs, endTs, minHour, maxHour) as any[];

        const insert = db.prepare(`
            INSERT OR REPLACE INTO leaderboard_daily_stats 
            (date, model_id, variable, lead_time_bucket, mae_sum, mse_sum, bias_sum, count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((rows: any[]) => {
            for (const row of rows) {
                insert.run(dateStr, row.model_id, row.variable, bucket, row.mae_sum, row.mse_sum, row.bias_sum, row.count);
            }
        });

        if (rows.length > 0) {
            insertMany(rows);
        }
    }
    console.timeEnd(label);
}

// NEW: Backfill all history (Chunked by day, Resume-able, Gentle)
export async function backfillStats() {
    console.log('[BACKFILL] Checking for missing daily stats...');

    // Get all distinct days from verifications
    const allDays = db.prepare(`
        SELECT DISTINCT date(datetime(valid_time / 1000, 'unixepoch')) as day 
        FROM verifications 
        ORDER BY day DESC
    `).all() as { day: string }[];

    // Get days already in stats
    const existingDays = new Set(
        (db.prepare('SELECT DISTINCT date FROM leaderboard_daily_stats').all() as { date: string }[]).map(r => r.date)
    );

    const missingDays = allDays.filter(d => d.day && !existingDays.has(d.day));

    console.log(`[BACKFILL] Found ${allDays.length} total days, ${missingDays.length} missing.`);

    if (missingDays.length === 0) {
        console.log('[BACKFILL] Up to date.');
        return;
    }

    console.log('[BACKFILL] Starting backfill for missing days...');

    for (const { day } of missingDays) {
        if (!day) continue;

        try {
            await aggregateDailyStats(day);
            console.log(`[BACKFILL] Processed ${day}`);
        } catch (e) {
            console.error(`[BACKFILL] Failed to process ${day}:`, e);
        }

        // SLEEP to protect CPU/IO
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('[BACKFILL] Complete.');
}

// NEW: Fast Leaderboard from Pre-aggregated Stats
function calculateLeaderboardFast(bucket: BucketName = '24h', variable: string = 'overall_score'): LeaderboardRow[] {
    const label = `[PERF] calculateLeaderboardFast(${bucket}, ${variable})`;
    console.time(label);

    let query = `
        SELECT 
            model_id, 
            variable, 
            SUM(mae_sum) / SUM(count) as mae, 
            SUM(mse_sum) / SUM(count) as mse, 
            SUM(bias_sum) / SUM(count) as bias,
            SUM(count) as n
        FROM leaderboard_daily_stats
        WHERE lead_time_bucket = ?
    `;

    const params: any[] = [bucket];

    if (variable !== 'overall_score') {
        query += ` AND variable = ?`;
        params.push(variable);
    }

    query += ` GROUP BY model_id, variable`;

    const statsRows = db.prepare(query).all(...params) as { model_id: string, variable: string, mae: number, mse: number, bias: number, n: number }[];

    // 2. Aggregate into Leaderboard Rows (Same logic as before, but faster inputs)
    const modelStats: Record<string, Partial<LeaderboardRow>> = {};
    const modelVarCounts: Record<string, number> = {};

    // Initialize
    MODELS.forEach(m => {
        modelStats[m.id] = { model: m.id, avg_mae: 0, avg_rmse: 0, avg_mse: 0, avg_bias: 0, total_verifications: 0 };
        modelVarCounts[m.id] = 0;
    });
    ['average_of_models', 'median_of_models'].forEach(id => {
        modelStats[id] = { model: id, avg_mae: 0, avg_rmse: 0, avg_mse: 0, avg_bias: 0, total_verifications: 0 };
        modelVarCounts[id] = 0;
    });

    statsRows.forEach(row => {
        if (!modelStats[row.model_id]) return;
        if (variable === 'overall_score' && row.variable === 'visibility') return;

        const threshold = MIN_MAE_THRESHOLDS[row.variable] || MIN_MAE_THRESHOLDS['default'];
        const normalizedMae = row.mae / threshold;

        const s = modelStats[row.model_id]!;
        s.avg_mae = (s.avg_mae || 0) + normalizedMae;
        s.avg_mse = (s.avg_mse || 0) + row.mse;
        s.avg_bias = (s.avg_bias || 0) + Math.abs(row.bias);
        s.total_verifications = Math.max((s.total_verifications || 0), row.n);

        modelVarCounts[row.model_id]++;
    });

    const leaderboard: LeaderboardRow[] = [];
    Object.values(modelStats).forEach(row => {
        const count = modelVarCounts[row.model as string];
        if (count > 0) {
            leaderboard.push({
                model: row.model!,
                avg_mae: row.avg_mae! / count,
                avg_rmse: Math.sqrt(row.avg_mse! / count),
                avg_mse: row.avg_mse! / count,
                avg_bias: row.avg_bias! / count,
                avg_corr: null,
                avg_skill: null,
                std_error: null,
                total_verifications: row.total_verifications!
            });
        }
    });

    const result = leaderboard.sort((a, b) => a.avg_mae - b.avg_mae);
    console.timeEnd(label);
    return result;
}

// Public cached accessor
export function getLeaderboard(bucket: BucketName = '24h', variable: string = 'overall_score'): LeaderboardRow[] {
    const row = db.prepare('SELECT data FROM leaderboard_cache WHERE bucket = ? AND variable = ?').get(bucket, variable) as { data: string } | undefined;

    if (row) {
        return JSON.parse(row.data);
    }

    // Fallback: Calculate on the fly if cache miss (and cache it)
    const data = calculateLeaderboardFast(bucket, variable);
    db.prepare('INSERT OR REPLACE INTO leaderboard_cache (bucket, variable, data, updated_at) VALUES (?, ?, ?, ?)').run(bucket, variable, JSON.stringify(data), Date.now());
    return data;
}

export async function refreshLeaderboardCache() {
    console.log('[CACHE] Refreshing leaderboard cache...');
    const variables = ['overall_score', ...FORECAST_VARIABLES];

    const insert = db.prepare('INSERT OR REPLACE INTO leaderboard_cache (bucket, variable, data, updated_at) VALUES (?, ?, ?, ?)');

    for (const bucket of ALL_BUCKETS) {
        for (const variable of variables) {
            // Yield to event loop to prevent blocking
            await new Promise(resolve => setImmediate(resolve));

            try {
                const data = calculateLeaderboardFast(bucket, variable);
                insert.run(bucket, variable, JSON.stringify(data), Date.now());
            } catch (e) {
                console.error(`[CACHE] Failed to refresh ${bucket}/${variable}:`, e);
            }
        }
    }

    console.log('[CACHE] Leaderboard cache refreshed.');
}

export function getModelDetails(modelId: string): ModelVariableStats[] {
    const rows = db.prepare(`
        SELECT 
            variable, 
            AVG(absolute_error) as mae, 
            AVG(squared_error) as mse, 
            AVG(bias) as bias,
            COUNT(DISTINCT valid_time) as n
        FROM verifications
        WHERE model_id = ?
        GROUP BY variable
    `).all(modelId) as { variable: string, mae: number, mse: number, bias: number, n: number }[];

    return rows.map(r => ({
        model_id: modelId,
        variable: r.variable,
        mae: r.mae,
        mse: r.mse,
        rmse: Math.sqrt(r.mse),
        bias: r.bias,
        mape: null,
        correlation: null,
        index_of_agreement: null,
        skill_score: null,
        std_error: null,
        n: r.n
    }));
}
