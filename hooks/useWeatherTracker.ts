
import { useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../services/apiClient';

export const useWeatherTracker = () => {
    const [status, setStatus] = useState('Initializing...');
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);
    const logsRef = useRef<string[]>(['Welcome to CYEG Weather Tracker!']);
    const [logs, setLogs] = useState<string[]>(logsRef.current);
    const [isInitialized, setIsInitialized] = useState(false);

    const log = useCallback((message: string) => {
        const timestamp = new Date().toLocaleTimeString();
        logsRef.current = [...logsRef.current, `${timestamp}: ${message}`].slice(-100);
        setLogs([...logsRef.current]);
        console.log(message);
    }, []);

    const checkStatus = useCallback(async () => {
        try {
            const serverStatus = await apiClient.getStatus();
            if (serverStatus.last_fetch) {
                setLastUpdated(serverStatus.last_fetch);
                setStatus('Idle');
                if (!isInitialized) setIsInitialized(true);
            } else {
                setStatus(serverStatus.status);
            }
        } catch (error) {
            setStatus('Error connecting to server');
        }
    }, [isInitialized]);

    const refresh = useCallback(async () => {
        try {
            setStatus('Triggering update...');
            log('Requesting server update...');
            await apiClient.triggerUpdate();
            log('Update triggered successfully.');
            // Poll status more frequently for a bit?
            setTimeout(checkStatus, 1000);
        } catch (error) {
            log(`Error triggering update: ${error}`);
            setStatus('Error');
        }
    }, [log, checkStatus]);

    useEffect(() => {
        checkStatus();
        const interval = setInterval(checkStatus, 30000); // Poll every 30s
        return () => clearInterval(interval);
    }, [checkStatus]);

    return { status, lastUpdated, logs, isInitialized, refresh };
};
