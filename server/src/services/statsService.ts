
import db from '../db';
import type { LeaderboardRow, ModelVariableStats, Observation, BucketName } from '../types';
import { MODELS, MIN_MAE_THRESHOLDS, MISSING_DATA_PENALTY_SCORE, LEAD_TIME_BUCKETS } from '../constants';

export function getLatestObservation(): Observation | null {
    const row = db.prepare('SELECT data FROM observations ORDER BY obs_time DESC LIMIT 1').get() as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data);
}

export function getRecentObservations(limit = 24): Observation[] {
    const rows = db.prepare('SELECT data FROM observations ORDER BY obs_time DESC LIMIT ?').all(limit) as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
}

export function getLeaderboard(bucket: BucketName = '24h', variable: string = 'overall_score'): LeaderboardRow[] {
    const [minHour, maxHour] = LEAD_TIME_BUCKETS[bucket];

    let query = `
        SELECT 
            model_id, 
            variable, 
            AVG(absolute_error) as mae, 
            AVG(squared_error) as mse, 
            AVG(bias) as bias,
            COUNT(*) as n
        FROM verifications
        WHERE lead_time_hours >= ? AND lead_time_hours < ?
    `;

    const params: any[] = [minHour, maxHour];

    if (variable !== 'overall_score') {
        query += ` AND variable = ?`;
        params.push(variable);
    }

    query += ` GROUP BY model_id, variable`;

    const statsRows = db.prepare(query).all(...params) as { model_id: string, variable: string, mae: number, mse: number, bias: number, n: number }[];

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

    return leaderboard.sort((a, b) => a.avg_mae - b.avg_mae);
}

export function getModelDetails(modelId: string): ModelVariableStats[] {
    const rows = db.prepare(`
        SELECT 
            variable, 
            AVG(absolute_error) as mae, 
            AVG(squared_error) as mse, 
            AVG(bias) as bias,
            COUNT(*) as n
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
