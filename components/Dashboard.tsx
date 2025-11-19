
import React, { useState } from 'react';
import type { BucketName } from '../types';
import { ALL_BUCKETS, BUCKET_LABELS, VERIFICATION_VARIABLES } from '../constants';
import TabContent from './TabContent';
import { CalendarDays, Thermometer, Wind, Eye, Gauge, CloudRain, Activity, Navigation, Compass, Snowflake, Droplets, CloudHail, Trophy } from 'lucide-react';

const SHORT_LABELS: Record<string, string> = {
  'overall_score': 'Overall Score',
  'temperature_2m': 'Temp',
  'dew_point_2m': 'Dew Point',
  'wind_speed_10m': 'Wind Spd',
  'wind_direction_10m': 'Wind Dir',
  'wind_gusts_10m': 'Gusts',
  'visibility': 'Visibility',
  'pressure_msl': 'Pressure',
  'precipitation': 'Precip (All)',
  'cloud_base_agl': 'Ceiling',
  'wind_vector': 'Vector Err',
  'precip_probability': 'Precip Brier',
  'rain_occurrence': 'Rain Hit/Miss',
  'snow_occurrence': 'Snow Hit/Miss',
  'freezing_rain_occurrence': 'FZRA Hit/Miss',
  'rain_amount': 'Liquid Rain',
  'snow_amount': 'Snow Amt',
  'freezing_rain_amount': 'Freezing Rain'
};

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

  const isOverall = selectedVariable === 'overall_score';

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
                className={`relative px-6 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 whitespace-nowrap focus:outline-none border group ${
                    activeTab === bucket
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

        {/* Section 2: Instrument Selector */}
        <div>
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-mono text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <Activity className="w-3 h-3 text-cyan-500" />
                    Telemetry Channel
                </h3>
                <div className="h-px flex-grow bg-gradient-to-r from-white/10 to-transparent ml-4"></div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {/* Overall Score Button (Special) */}
                <button 
                    onClick={() => setSelectedVariable('overall_score')}
                    className={`
                        flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all duration-200 group relative overflow-hidden col-span-2 sm:col-span-1
                        ${isOverall
                            ? 'bg-gradient-to-br from-yellow-950/30 to-slate-900 border-yellow-500/50 text-white shadow-[0_0_15px_rgba(234,179,8,0.15)]' 
                            : 'bg-slate-950/50 border-white/5 text-slate-400 hover:bg-white/5 hover:border-white/20 hover:text-slate-200'
                        }
                    `}
                >
                    {isOverall && <div className="absolute left-0 top-0 bottom-0 w-1 bg-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.8)]"></div>}
                    <div className={`
                        p-2 rounded-lg transition-colors
                        ${isOverall ? 'bg-yellow-500/20 text-yellow-400' : 'bg-slate-900 text-slate-500 group-hover:text-slate-400'}
                    `}>
                        <Trophy className="w-4 h-4" />
                    </div>
                    <span className={`text-sm font-bold tracking-tight z-10 ${isOverall ? 'text-yellow-100' : ''}`}>
                        Overall Score
                    </span>
                </button>

                {VERIFICATION_VARIABLES.map(variable => {
                    const isSelected = selectedVariable === variable.name;
                    return (
                        <button 
                            key={variable.name}
                            onClick={() => setSelectedVariable(variable.name)}
                            className={`
                                flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all duration-200 group relative overflow-hidden
                                ${isSelected 
                                    ? 'bg-gradient-to-br from-cyan-950/50 to-slate-900 border-cyan-500/50 text-white shadow-[0_0_15px_rgba(34,211,238,0.15)]' 
                                    : 'bg-slate-950/50 border-white/5 text-slate-400 hover:bg-white/5 hover:border-white/20 hover:text-slate-200'
                                }
                            `}
                        >
                            {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1 bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)]"></div>}
                            
                            <div className={`
                                p-2 rounded-lg transition-colors
                                ${isSelected ? 'bg-cyan-400/20 text-cyan-300' : 'bg-slate-900 text-slate-500 group-hover:text-slate-400'}
                            `}>
                                {getIcon(variable.name)}
                            </div>
                            <span className="text-sm font-medium tracking-tight z-10">
                                {SHORT_LABELS[variable.name] || variable.name}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
      </div>

      {/* Main Content Area */}
      <TabContent bucketName={activeTab} selectedVariable={selectedVariable} />
    </div>
  );
};

export default Dashboard;
