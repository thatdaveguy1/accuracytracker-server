import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(__dirname, '../../weather.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

export const initDB = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS forecasts (
            id TEXT PRIMARY KEY,
            model_id TEXT,
            issue_time INTEGER,
            valid_time INTEGER,
            data TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_forecasts_valid_time ON forecasts(valid_time);
        CREATE INDEX IF NOT EXISTS idx_forecasts_model_id ON forecasts(model_id);
        CREATE INDEX IF NOT EXISTS idx_forecasts_issue_time ON forecasts(issue_time);

        CREATE TABLE IF NOT EXISTS observations (
            obs_time INTEGER PRIMARY KEY,
            report_type TEXT,
            data TEXT
        );

        CREATE TABLE IF NOT EXISTS verifications (
            key TEXT PRIMARY KEY,
            model_id TEXT,
            variable TEXT,
            valid_time INTEGER,
            issue_time INTEGER,
            lead_time_hours REAL,
            forecast_value REAL,
            observed_value REAL,
            error REAL,
            absolute_error REAL,
            squared_error REAL,
            bias REAL
        );
        CREATE INDEX IF NOT EXISTS idx_verifications_model_var ON verifications(model_id, variable);
        CREATE INDEX IF NOT EXISTS idx_verifications_valid_time ON verifications(valid_time);
        CREATE INDEX IF NOT EXISTS idx_verifications_lead_time ON verifications(lead_time_hours, variable);
        
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS leaderboard_cache (
            bucket TEXT,
            variable TEXT,
            data TEXT,
            updated_at INTEGER,
            PRIMARY KEY (bucket, variable)
        );
    `);
    console.log('[DB] Initialized SQLite database');
};

export default db;
