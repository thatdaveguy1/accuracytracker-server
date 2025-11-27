import React, { useEffect, useState } from 'react';
import { fetchTAF } from '../services/weatherService';
import * as db from '../services/db';
import type { Observation } from '../types';
import { ArrowLeft, Wind, Droplets, Eye, Thermometer } from 'lucide-react';

interface MetarPageProps {
    onBack: () => void;
}

const MetarPage: React.FC<MetarPageProps> = ({ onBack }) => {
    const [observations, setObservations] = useState<Observation[]>([]);
    const [taf, setTaf] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadData = async () => {
            const obs = await db.getAll<Observation>('observations');
            // Sort descending by time
            const sorted = obs.sort((a, b) => b.obs_time - a.obs_time);
            setObservations(sorted);

            const tafText = await fetchTAF();
            setTaf(tafText);
            setLoading(false);
        };
        loadData();
    }, []);

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-4">
                <button
                    onClick={onBack}
                    className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-400 hover:text-white"
                >
                    <ArrowLeft className="h-6 w-6" />
                </button>
                <h2 className="text-2xl font-light text-white">METAR & TAF History</h2>
            </div>

            <p className="text-sm text-slate-400">{observations.length} observations loaded</p>
            <div className="bg-slate-900/50 border border-white/10 rounded-xl p-6 backdrop-blur-sm">
                <h3 className="text-sm font-mono text-slate-400 uppercase tracking-wider mb-3">Current TAF (Terminal Aerodrome Forecast)</h3>
                {loading ? (
                    <div className="h-20 animate-pulse bg-white/5 rounded-lg" />
                ) : (
                    <div className="font-mono text-sm text-emerald-400 whitespace-pre-wrap leading-relaxed">
                        {taf || 'No TAF available.'}
                    </div>
                )}
            </div>

            {/* METAR List */}
            <div className="space-y-4">
                <h3 className="text-sm font-mono text-slate-400 uppercase tracking-wider">Last 48 Hours Observations</h3>

                {loading ? (
                    [...Array(5)].map((_, i) => (
                        <div key={i} className="h-24 bg-slate-900/50 border border-white/5 rounded-xl animate-pulse" />
                    ))
                ) : (
                    observations.map((obs) => (
                        <div key={obs.obs_time} className="bg-slate-900/50 border border-white/10 rounded-xl p-4 hover:bg-white/5 transition-colors">
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-3">
                                <div className="flex items-center gap-3">
                                    <span className={`px-2 py-1 rounded text-xs font-bold ${obs.report_type === 'SPECI' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                                        {obs.report_type}
                                    </span>
                                    <span className="font-mono text-white text-lg">
                                        {new Date(obs.obs_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                                    </span>
                                    <span className="text-xs text-slate-500">
                                        {new Date(obs.obs_time).toLocaleDateString()}
                                    </span>
                                </div>
                                <div className="font-mono text-xs text-slate-400 break-all bg-black/30 p-2 rounded border border-white/5">
                                    {obs.raw_text}
                                </div>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div className="flex items-center gap-2 text-slate-300">
                                    <Thermometer className="h-4 w-4 text-red-400" />
                                    <span>{obs.temperature?.toFixed(1)}°C</span>
                                    <span className="text-slate-500 text-xs">({obs.dewpoint?.toFixed(1)}°C)</span>
                                </div>
                                <div className="flex items-center gap-2 text-slate-300">
                                    <Wind className="h-4 w-4 text-cyan-400" />
                                    <span>{obs.wind_dir}° @ {obs.wind_speed ? (obs.wind_speed / 1.852).toFixed(0) : '--'}kt</span>
                                    {obs.wind_gust && <span className="text-amber-400 text-xs">G{(obs.wind_gust / 1.852).toFixed(0)}</span>}
                                </div>
                                <div className="flex items-center gap-2 text-slate-300">
                                    <Eye className="h-4 w-4 text-emerald-400" />
                                    <span>{obs.visibility ? (obs.visibility / 1000).toFixed(1) + 'km' : '--'}</span>
                                </div>
                                <div className="flex items-center gap-2 text-slate-300">
                                    <Droplets className="h-4 w-4 text-blue-400" />
                                    <span>{obs.pressure_msl?.toFixed(1)} hPa</span>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default MetarPage;
