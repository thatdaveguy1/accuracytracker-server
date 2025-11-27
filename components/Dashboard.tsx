
import React, { useState } from 'react';
import type { BucketName } from '../types';
import { ALL_BUCKETS, BUCKET_LABELS } from '../constants';
import TabContent from './TabContent';
import { CalendarDays, Thermometer, Wind, Eye, Gauge, CloudRain, Activity, Navigation, Compass, Snowflake, Droplets, CloudHail, Trophy } from 'lucide-react';

const SHORT_LABELS: Record<string, string> = {
    'overall_score': 'Overall Score',
    'temperature_2m': 'Temp',
    'dew_point_2m': 'Dew Point',
    'pressure_msl': 'Pressure',
    'visibility': 'Visibility',
    'cloud_base_agl': 'Ceiling',
    'wind_speed_10m': 'Wind Speed',
    'wind_direction_10m': 'Wind Direction',
    'wind_gusts_10m': 'Gusts',
    'wind_vector': 'Vector Error',
    'precipitation': 'Total Precip',
    'rain_amount': 'Rainfall',
    'snow_amount': 'Snowfall',
    'freezing_rain_amount': 'Ice Accumulation',
    'precip_probability': 'Precip Probability Score',
    'rain_occurrence': 'Rain Detection',
    'snow_occurrence': 'Snow Detection',
    'freezing_rain_occurrence': 'Ice Detection'
};

const VARIABLE_GROUPS = [
    {
        title: 'OVERALL',
        vars: ['overall_score']
    },
    {
        title: 'THE BASICS',
        vars: ['temperature_2m', 'dew_point_2m', 'pressure_msl']
    },
    {
        title: 'SKY & VISIBILITY',
        vars: ['visibility', 'cloud_base_agl']
    },
    {
        title: 'WIND DYNAMICS',
        vars: ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'wind_vector']
    },
    {
        title: 'QUANTITIES',
        vars: ['precipitation', 'rain_amount', 'snow_amount', 'freezing_rain_amount']
    },
    {
        title: 'SKILL SCORES (QUALITY)',
        vars: ['precip_probability', 'rain_occurrence', 'snow_occurrence', 'freezing_rain_occurrence']
    }
];

const getIcon = (key: string) => {
    if (key === 'overall_score') return <Trophy className="w-4 h-4 text-yellow-400" />;
    if (key.includes('probability')) return <Droplets className="w-4 h-4" />;
    if (key.includes('temperature') || key.includes('dew')) return <Thermometer className="w-4 h-4" />;
    if (key.includes('wind_direction')) return <Compass className="w-4 h-4" />;
    if (key.includes('vector')) return <Navigation className="w-4 h-4" />;
    if (key.includes('wind') || key.includes('gust')) return <Wind className="w-4 h-4" />;
    if (key.includes('visibility')) return <Eye className="w-4 h-4" />;
    if (key.includes('pressure')) return <Gauge className="w-4 h-4" />;
    if (key.includes('snow')) return <Snowflake className="w-4 h-4" />;
    if (key.includes('freezing')) return <CloudHail className="w-4 h-4" />;
    if (key.includes('precip') || key.includes('rain')) return <CloudRain className="w-4 h-4" />;
    if (key.includes('cloud') || key.includes('ceiling')) return <Activity className="w-4 h-4" />;
    return <Activity className="w-4 h-4" />;
};

const Dashboard: React.FC = () => {
    const [activeTab, setActiveTab] = useState<BucketName>('24h');
    const [selectedVariable, setSelectedVariable] = useState<string>('overall_score');

    return (
        <div className="space-y-8">
            {/* Control Panel Container */}
            <div className="bg-slate-900/80 border border-white/10 rounded-2xl p-6 backdrop-blur-md shadow-2xl flex flex-col gap-8 relative overflow-hidden">
                {/* Decorative Background Elements */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

                {/* Section 1: Lead Time */}
                <div>
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-xs font-mono text-slate-400 uppercase tracking-widest flex items-center gap-2">
                            <CalendarDays className="w-3 h-3 text-cyan-500" />
                            Forecast Range
                        </h3>
                        <div className="h-px flex-grow bg-gradient-to-r from-white/10 to-transparent ml-4"></div>
                    </div>

                    <div className="flex items-center gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                        {ALL_BUCKETS.map(bucket => (
                            <button
                                key={bucket}
                                onClick={() => setActiveTab(bucket)}
                                className={`relative px-6 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 whitespace-nowrap focus:outline-none border group ${activeTab === bucket
                                        ? 'bg-slate-800 border-cyan-500/50 text-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.15)]'
                                        : 'bg-slate-950/50 border-white/5 text-slate-400 hover:border-white/20 hover:text-slate-200 hover:bg-white/5'
                                    }`}
                            >
                                {activeTab === bucket && (
                                    <span className="absolute inset-0 bg-cyan-400/5 rounded-lg animate-pulse"></span>
                                )}
                                {BUCKET_LABELS[bucket]}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Section 2: Variable Groups */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
                    {VARIABLE_GROUPS.map((group) => (
                        <div key={group.title} className="flex flex-col gap-3">
                            {/* Group Header */}
                            <div className="flex items-center gap-3 mb-1">
                                <div className="w-3 h-3 border-l border-t border-slate-600"></div>
                                <h3 className="text-xs font-mono text-slate-300 uppercase tracking-widest">{group.title}</h3>
                                <div className="h-px flex-grow bg-slate-800"></div>
                                <div className="w-3 h-3 border-r border-t border-slate-600"></div>
                            </div>

                            {/* Group Buttons */}
                            <div className="grid grid-cols-1 gap-2 pl-2 border-l border-slate-800/50 ml-1.5">
                                {group.vars.map(varKey => {
                                    const isSelected = selectedVariable === varKey;
                                    const isOverall = varKey === 'overall_score';

                                    return (
                                        <button
                                            key={varKey}
                                            onClick={() => setSelectedVariable(varKey)}
                                            className={`
                                        flex items-center justify-between px-4 py-2 rounded-lg border text-left transition-all duration-200 group relative overflow-hidden
                                        ${isSelected
                                                    ? (isOverall
                                                        ? 'bg-yellow-950/30 border-yellow-500/50 text-yellow-100'
                                                        : 'bg-cyan-950/30 border-cyan-500/50 text-cyan-100')
                                                    : 'bg-slate-950/30 border-white/5 text-slate-400 hover:bg-white/5 hover:border-white/20 hover:text-slate-200'
                                                }
                                    `}
                                        >
                                            <div className="flex items-center gap-3 z-10">
                                                <div className={`
                                            p-1.5 rounded-md transition-colors
                                            ${isSelected
                                                        ? (isOverall ? 'bg-yellow-500/20 text-yellow-400' : 'bg-cyan-400/20 text-cyan-300')
                                                        : 'bg-slate-900 text-slate-500 group-hover:text-slate-400'}
                                        `}>
                                                    {getIcon(varKey)}
                                                </div>
                                                <span className="text-sm font-mono tracking-tight">
                                                    {SHORT_LABELS[varKey] || varKey}
                                                </span>
                                            </div>

                                            {isSelected && (
                                                <div className={`w-1.5 h-1.5 rounded-full ${isOverall ? 'bg-yellow-500' : 'bg-cyan-400'} shadow-[0_0_8px_currentColor]`}></div>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="flex justify-between px-1.5 -mt-2">
                                <div className="w-3 h-3 border-l border-b border-slate-600"></div>
                                <div className="w-3 h-3 border-r border-b border-slate-600"></div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Main Content Area */}
            <TabContent bucketName={activeTab} selectedVariable={selectedVariable} />
        </div>
    );
};

export default Dashboard;
