
import React, { useEffect, useState } from 'react';
import { Observation } from '../types';
import { getLatestObservation } from '../services/weatherService';
import { Wind, Thermometer, Eye, ArrowUp, Cloud, Zap } from 'lucide-react';

const CurrentConditions: React.FC = () => {
  const [obs, setObs] = useState<Observation | null>(null);

  useEffect(() => {
    // Poll for the latest observation whenever component mounts
    getLatestObservation().then(setObs);
  }, []);

  if (!obs) return null;
  
  // Check if this is a real METAR or an ERA5-filled synthetic report
  const isSynthetic = obs.report_type === 'SYNTHETIC';

  // Helper: Calculate Flight Category (VFR/IFR/LIFR) based on Visibility & Ceiling
  const getFlightCategory = (vis: number | null, ceiling: number | null) => {
    if (vis === null) return { cat: 'N/A', color: 'text-slate-500', bg: 'bg-slate-500/10', border: 'border-slate-500/20' };
    
    // Vis in km -> miles. Ceiling in meters -> feet.
    // Note: We normalized visibility to meters in weatherService, so convert meters -> SM
    const visSm = vis * 0.000621371;
    const ceilFt = ceiling !== null ? ceiling * 3.28084 : 10000;

    if (visSm < 1 || ceilFt < 500) return { cat: 'LIFR', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' };
    if (visSm < 3 || ceilFt < 1000) return { cat: 'IFR', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' };
    if (visSm <= 5 || ceilFt <= 3000) return { cat: 'MVFR', color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' };
    return { cat: 'VFR', color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' };
  };

  const flightCat = getFlightCategory(obs.visibility, obs.ceiling_agl);

  return (
    <div className="bg-slate-900/60 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-lg relative overflow-hidden mb-8">
       {/* Dynamic Background Glow based on flight rules (Green=VFR, Blue=MVFR, etc) */}
       <div className={`absolute -right-10 -top-10 w-48 h-48 rounded-full blur-[60px] opacity-20 pointer-events-none ${flightCat.cat === 'VFR' ? 'bg-emerald-500' : 'bg-blue-500'}`}></div>

       <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative z-10">
          
          {/* Main Temperature & ID Section */}
          <div className="flex items-center gap-6">
              <div className="bg-slate-950 p-4 rounded-2xl border border-white/5 shadow-inner">
                  <div className="text-4xl font-bold text-white tracking-tight flex items-start gap-1">
                      {obs.temperature !== null ? obs.temperature.toFixed(1) : '--'}<span className="text-lg text-slate-400 mt-1">°C</span>
                  </div>
                  <div className="text-xs text-slate-500 font-mono mt-1 flex items-center gap-1">
                      <Thermometer className="w-3 h-3" />
                      Dew: {obs.dewpoint !== null ? obs.dewpoint.toFixed(1) : '--'}°
                  </div>
              </div>
              
              <div>
                  <div className="flex items-center gap-3 mb-1">
                      <h2 className="text-xl font-bold text-slate-200">Current Conditions</h2>
                      {/* Show Flight Category for Real METARs */}
                      {!isSynthetic && (
                        <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded border ${flightCat.bg} ${flightCat.color} ${flightCat.border}`}>
                            {flightCat.cat}
                        </span>
                      )}
                      {/* Show ERA5 Tag for Synthetic Reports */}
                      {isSynthetic && (
                          <span className="text-xs font-bold font-mono px-2 py-0.5 rounded border bg-amber-500/10 text-amber-400 border-amber-500/20 flex items-center gap-1">
                             <Zap className="h-3 w-3" /> ERA5 FILL
                          </span>
                      )}
                  </div>
                  <p className="text-sm text-slate-400 font-mono">
                     {new Date(obs.obs_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', timeZoneName:'short'})}
                  </p>
                  <div className="flex gap-2 mt-2">
                      {obs.weather_codes.map((code, i) => (
                          <span key={i} className="text-[10px] font-bold bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-white/5">
                              {code}
                          </span>
                      ))}
                      {isSynthetic && <span className="text-[10px] text-slate-500 italic">METAR unavailable</span>}
                  </div>
              </div>
          </div>

          {/* Key Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-4 w-full md:w-auto">
              
              {/* Wind & Gusts */}
              <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest flex items-center gap-1">
                      <Wind className="w-3 h-3" /> Wind
                  </span>
                  <div className="text-sm font-medium text-slate-200 font-mono">
                      {obs.wind_dir !== null ? obs.wind_dir : '---'}° <span className="text-slate-500">@</span> {obs.wind_speed !== null ? obs.wind_speed.toFixed(0) : '--'}
                      <span className="text-[10px] text-slate-500 ml-1">km/h</span>
                  </div>
                  {(obs.wind_gust !== null || obs.era_wind_gust !== null) && (
                      <div className="text-xs text-amber-400 font-mono">
                          Gust {((obs.wind_gust ?? obs.era_wind_gust) || 0).toFixed(0)}
                      </div>
                  )}
              </div>

              {/* Visibility */}
              <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest flex items-center gap-1">
                      <Eye className="w-3 h-3" /> Vis
                  </span>
                  <div className="text-sm font-medium text-slate-200 font-mono">
                      {obs.visibility !== null ? (obs.visibility * 0.000621371).toFixed(1) : '--'}
                      <span className="text-[10px] text-slate-500 ml-1">SM</span>
                  </div>
              </div>

              {/* Ceiling */}
              <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest flex items-center gap-1">
                      <Cloud className="w-3 h-3" /> Ceiling
                  </span>
                  <div className="text-sm font-medium text-slate-200 font-mono">
                      {obs.ceiling_agl !== null ? Math.round(obs.ceiling_agl * 3.28084) : (isSynthetic ? '--' : 'UNL')}
                      <span className="text-[10px] text-slate-500 ml-1">{obs.ceiling_agl !== null ? 'ft' : ''}</span>
                  </div>
              </div>

              {/* Pressure / Altimeter */}
              <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest flex items-center gap-1">
                      <ArrowUp className="w-3 h-3" /> Altim
                  </span>
                  <div className="text-sm font-medium text-slate-200 font-mono">
                      {obs.pressure_msl !== null ? (obs.pressure_msl / 33.8639).toFixed(2) : '--'}
                      <span className="text-[10px] text-slate-500 ml-1">inHg</span>
                  </div>
              </div>
          </div>
       </div>
       
       <div className="mt-4 pt-3 border-t border-white/5 flex justify-between">
           <p className="font-mono text-[10px] text-slate-600 truncate opacity-70">
               RAW: {obs.raw_text || 'N/A'}
           </p>
           {isSynthetic && <span className="text-[10px] text-amber-500/50 uppercase tracking-widest font-mono">Est. Analysis</span>}
       </div>
    </div>
  );
};

export default CurrentConditions;
