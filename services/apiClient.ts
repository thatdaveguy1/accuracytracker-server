
import type { Observation, LeaderboardRow, ModelVariableStats } from '../types';

const API_BASE = '/api';

export const apiClient = {
    async getLatestObservation(): Promise<Observation | null> {
        const res = await fetch(`${API_BASE}/current-conditions`);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    },

    async getHistory(limit = 24): Promise<Observation[]> {
        const res = await fetch(`${API_BASE}/history?limit=${limit}`);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    },

    async getLeaderboard(bucket = '24h', variable = 'overall_score'): Promise<LeaderboardRow[]> {
        const res = await fetch(`${API_BASE}/leaderboard?bucket=${bucket}&variable=${variable}`);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    },

    async getModelDetails(modelId: string): Promise<ModelVariableStats[]> {
        const res = await fetch(`${API_BASE}/model/${modelId}`);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    },

    async getTAF(): Promise<string | null> {
        const res = await fetch(`${API_BASE}/taf`);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        const data = await res.json();
        return data.taf;
    },

    async getStatus(): Promise<{ status: string, last_fetch: number | null, server_time: number }> {
        const res = await fetch(`${API_BASE}/status`);
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return res.json();
    },

    async triggerUpdate(): Promise<void> {
        const res = await fetch(`${API_BASE}/trigger-update`, { method: 'POST' });
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
    }
};
