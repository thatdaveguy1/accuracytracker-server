import React, { useEffect, useState } from 'react';
import { Observation } from '../types';
import { getLatestObservation } from '../services/weatherService';
import { Wind, Thermometer, Eye, ArrowUp, Cloud, Zap, Gauge, Navigation, Droplets } from 'lucide-react';

const CurrentConditions: React.FC = () => {
    const [obs, setObs] = useState<Observation | null>(null);

    useEffect(() => {
        getLatestObservation().then(setObs);
    }, []);

    if (!obs) return null;

    const isSynthetic = obs.report_type === 'SYNTHETIC';

    // Flight Category Logic
    const getFlightCategory = (vis: number | null, ceiling: number | null) => {
        if (vis === null) return { cat: 'N/A', color: 'text-slate-500', bg: 'bg-slate-500/10', border: 'border-slate-500/20', glow: 'slate' };
        const visSm = vis * 0.000621371;
        const ceilFt = ceiling !== null ? ceiling * 3.28084 : 10000;

        if (visSm < 1 || ceilFt < 500) return { cat: 'LIFR', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20', glow: 'purple' };
        if (visSm < 3 || ceilFt < 1000) return { cat: 'IFR', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20', glow: 'red' };
        if (visSm <= 5 || ceilFt <= 3000) return { cat: 'MVFR', color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', glow: 'blue' };
        return { cat: 'VFR', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', glow: 'emerald' };
    };

    const flightCat = getFlightCategory(obs.visibility, obs.ceiling_agl);

    // Helper for metric cards
    const MetricCard = ({ icon: Icon, label, value, sub, colorClass = "text-slate-200" }: any) => (
        <div className="bg-slate-950/50 border border-white/5 rounded-xl p-4 flex flex-col gap-1 hover:bg-white/5 transition-colors group">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-1">
                <Icon className="w-3 h-3" /> {label}
            </div>
            <div className={`text-lg font-mono font-medium ${colorClass}`}>
                {value}
            </div>
            {sub && <div className="text-xs text-slate-500 font-mono">{sub}</div>}
        </div>
    );

    return (
        <div className="relative overflow-hidden rounded-3xl bg-slate-900 border border-white/10 shadow-2xl p-0 mb-8 group">
            {/* Ambient Glow */}
            <div className={`absolute top-0 right-0 w-96 h-96 bg-${flightCat.glow}-500/10 rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 pointer-events-none`}></div>

            <div className="p-6 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8 relative z-10">

                {/* LEFT: Main Status (Temp + Category) */}
                <div className="lg:col-span-4 flex flex-col justify-between gap-6 border-b lg:border-b-0 lg:border-r border-white/5 pb-6 lg:pb-0 lg:pr-8">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest">Current Conditions</h2>
                            {!isSynthetic ? (
                                <span className={`text-[10px] font-bold font-mono px-2 py-0.5 rounded border ${flightCat.bg} ${flightCat.color} ${flightCat.border}`}>
                                    {flightCat.cat}
                                </span>
                            ) : (
                                <span className="text-[10px] font-bold font-mono px-2 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20 flex items-center gap-1">
                                    <Zap className="h-3 w-3" /> ERA5 FILL
                                </span>
                            )}
                        </div>
                        <div className="text-xs text-slate-500 font-mono">
                            {new Date(obs.obs_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}
                        </div>
                    </div>

                    <div className="flex items-end gap-4">
                        <div className="text-6xl font-light text-white tracking-tighter">
                            {obs.temperature !== null ? obs.temperature.toFixed(1) : '--'}°
                        </div>
                        <div className="flex flex-col mb-2 gap-1">
                            <div className="flex items-center gap-2 text-sm text-slate-400 font-mono">
                                <Droplets className="w-3 h-3 text-cyan-500" />
                                Dew {obs.dewpoint !== null ? obs.dewpoint.toFixed(1) : '--'}°
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {obs.weather_codes.length > 0 ? (
                            obs.weather_codes.map((code, i) => (
                                <span key={i} className="text-xs font-bold bg-slate-800 text-slate-300 px-2 py-1 rounded-md border border-white/5 shadow-sm">
                                    {code}
                                </span>
                            ))
                        ) : (
                            <span className="text-xs text-slate-600 italic px-2">No significant weather</span>
                        )}
                    </div>
                </div>

                {/* RIGHT: Metrics Grid */}
                <div className="lg:col-span-8 grid grid-cols-2 md:grid-cols-4 gap-4">
                    {/* Wind */}
                    <MetricCard
                        icon={Wind}
                        label="Wind"
                        value={
                            <span className="flex items-baseline gap-1">
                                {obs.wind_variable ? 'VRB' : (obs.wind_dir !== null ? obs.wind_dir + '°' : '---°')}
                                <span className="text-sm text-slate-500">@</span>
                                {obs.wind_speed !== null ? (obs.wind_speed / 1.852).toFixed(0) : '--'}
                                <span className="text-xs text-slate-500">kt</span>
                            </span>
                        }
                        sub={obs.wind_gust ? <span className="text-amber-400">Gust {(obs.wind_gust / 1.852).toFixed(0)} kt</span> : null}
                    />

                    {/* Visibility */}
                    <MetricCard
                        icon={Eye}
                        label="Visibility"
                        value={`${obs.visibility ? (obs.visibility / 1609.34).toFixed(1) : '--'} SM`}
                        colorClass="text-emerald-400"
                    />

                    {/* Ceiling */}
                    <MetricCard
                        icon={Cloud}
                        label="Ceiling"
                        value={obs.ceiling_agl ? `${(obs.ceiling_agl * 3.28084).toFixed(0)} ft` : 'Unlimited'}
                        colorClass={obs.ceiling_agl ? "text-blue-400" : "text-slate-400"}
                    />

                    {/* Pressure */}
                    <MetricCard
                        icon={Gauge}
                        label="Altimeter"
                        value={`${obs.pressure_msl ? (obs.pressure_msl / 33.8639).toFixed(2) : '--'} inHg`}
                    />
                </div>
            </div>

            {/* Footer: Raw Text */}
            <div className="bg-black/20 border-t border-white/5 p-3 px-6 md:px-8">
                <div className="font-mono text-[10px] text-slate-500 break-all opacity-60 hover:opacity-100 transition-opacity">
                    RAW: {obs.raw_text}
                </div>
            </div>
        </div>
    );
};

export default CurrentConditions;
