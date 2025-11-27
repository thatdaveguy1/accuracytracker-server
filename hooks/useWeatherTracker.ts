
import { useState, useEffect, useCallback, useRef } from 'react';
import * as db from '../services/db';
import * as weatherService from '../services/weatherService';

export const useWeatherTracker = () => {
    const [status, setStatus] = useState('Initializing...');
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);

    // Optimized Logging: 
    // 1. useRef stores the actual logs immediately (no closure staleness).
    // 2. useState triggers re-renders, but throttled.
    const logsRef = useRef<string[]>(['Welcome to CYEG Weather Tracker!']);
    const [logs, setLogs] = useState<string[]>(logsRef.current);

    const [isInitialized, setIsInitialized] = useState(false);
    const isRunning = useRef(false);

    // Throttled UI Sync: Only update React state every 200ms max
    useEffect(() => {
        const interval = setInterval(() => {
            setLogs(prev => {
                // Simple length/content check to avoid unnecessary state updates
                if (prev.length !== logsRef.current.length || prev[prev.length - 1] !== logsRef.current[logsRef.current.length - 1]) {
                    return [...logsRef.current];
                }
                return prev;
            });
        }, 200);
        return () => clearInterval(interval);
    }, []);

    const log = useCallback((message: string) => {
        const timestamp = new Date().toLocaleTimeString();
        // Store in ref immediately
        logsRef.current = [...logsRef.current, `${timestamp}: ${message}`].slice(-100);
        // Console log immediately for debugging
        console.log(message);
    }, []);

    useEffect(() => {
        weatherService.setLogger(log);
    }, [log]);

    const runFullUpdate = useCallback(async (forceForecastFetch = false) => {
        if (isRunning.current) {
            log('[APP] Update already in progress, skipping.');
            return;
        }

        isRunning.current = true;

        try {
            await db.openDB();

            // Prevent redundant updates if last run was < 5 mins ago (unless forced)
            // Prevent redundant updates if last run was < 5 mins ago (unless forced)
            const lastRun = await db.getMetadata<number>('last_run_end');
            if (!forceForecastFetch && lastRun && (Date.now() - lastRun < 5 * 60 * 1000)) {
                log('[APP] Data is up to date (Cached). Skipping refresh.');
                setLastUpdated(lastRun);
                setStatus('Cached'); // Explicitly set status to Cached
                setIsInitialized(true); // Ensure initialized is true
                isRunning.current = false;
                return;
            }

            const lastFetch = await db.getMetadata<number>('last_forecast_fetch');
            const oneHourAgo = Date.now() - 3600 * 1000;

            // FORECAST FETCH LOGIC:
            // Only fetch if forced OR last fetch was > 1 hour ago
            if (forceForecastFetch || !lastFetch || lastFetch < oneHourAgo) {
                if (forceForecastFetch) log('[APP] Forcing forecast fetch.');
                else log('[APP] New forecast cycle detected or cache expired.');
                setStatus('Fetching models...');
                await weatherService.fetchAllModels();
            } else {
                log(`[APP] Forecasts cached (Updated: ${new Date(lastFetch).toLocaleTimeString()})`);
            }

            setStatus('Fetching observations...');
            await weatherService.fetchMETARHistory();

            setStatus('Running verification...');
            await weatherService.runVerification();

            const obsCount = await db.getCount('observations');
            if (obsCount < 2) {
                log('[APP] Leaderboard will activate after 2nd observation arrives.');
            }

            setStatus('Cleaning up old data...');
            await weatherService.cleanupOldData();

            const now = Date.now();
            setLastUpdated(now);
            await db.setMetadata('last_run_end', now);

            setStatus('Idle');
            log('[APP] Update cycle complete.');

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log(`[APP] Error: ${errorMessage}`);
            setStatus('Error');
            // We don't throw here to keep the app alive, just log status
        } finally {
            isRunning.current = false;
        }
    }, [log]);

    useEffect(() => {
        let mounted = true;

        const initialize = async () => {
            await runFullUpdate();
            if (mounted) setIsInitialized(true);
        };

        initialize().catch(err => {
            if (mounted) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                log(`[APP] CRITICAL: Initialization failed: ${errorMessage}`);
                setStatus('Error');
            }
        });

        const intervalId = setInterval(() => {
            log('[AUTO] Hourly refresh triggered');
            runFullUpdate();
        }, 3600 * 1000);

        return () => {
            mounted = false;
            clearInterval(intervalId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { status, lastUpdated, logs, isInitialized, refresh: () => runFullUpdate(true) };
};
