
import React from 'react';
import type { LeaderboardRow } from '../types';
import { Trophy, Info, Calculator } from 'lucide-react';
import { MODEL_LABELS } from '../constants';

interface LeaderboardTableProps {
  data: LeaderboardRow[];
  isComposite?: boolean;
}

const modelDisplay = (modelId: string) => {
    return MODEL_LABELS[modelId] || modelId.toUpperCase();
};

const formatScore = (val: number | null | undefined) => {
    if (val === null || val === undefined || !Number.isFinite(val)) return '--';
    return val.toFixed(3);
};

const formatBias = (val: number | null | undefined) => {
    if (val === null || val === undefined || !Number.isFinite(val)) return '--';
    return (val > 0 ? '+' : '') + val.toFixed(2);
};

const LeaderboardTable: React.FC<LeaderboardTableProps> = ({ data, isComposite = false }) => {
  // Filter out empty rows to hide models with no data
  const validData = data.filter(row => row.total_verifications > 0);

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Card Container */}
      <div className="flex-grow bg-slate-900/60 border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-xl flex flex-col">
        
        {/* Header */}
        <div className="p-4 border-b border-white/5 bg-white/[0.02] flex items-center justify-between">
            <h3 className="text-slate-100 font-semibold flex items-center gap-2 text-sm tracking-wide">
                <Trophy className={`h-4 w-4 ${isComposite ? 'text-yellow-400' : 'text-amber-400'}`} />
                {isComposite ? 'OVERALL PERFORMANCE RANKINGS' : 'PERFORMANCE RANKINGS'}
            </h3>
            <span className="text-[10px] font-mono text-cyan-400/80 bg-cyan-900/20 border border-cyan-500/20 px-2 py-0.5 rounded shadow-[0_0_10px_rgba(34,211,238,0.1)]">
                SORT: LOWEST {isComposite ? 'SCORE' : 'MAE/VRMSE'}
            </span>
        </div>

        {/* Table Wrapper */}
        <div className="overflow-x-auto flex-grow custom-scrollbar">
            <table className="w-full text-sm text-left border-collapse">
            <thead className="text-xs text-slate-500 uppercase font-mono bg-black/20 sticky top-0 z-10 backdrop-blur-md">
                <tr>
                <th className="px-4 py-3 font-medium tracking-wider border-b border-white/5">Rank</th>
                <th className="px-4 py-3 font-medium tracking-wider border-b border-white/5">Model</th>
                <th className="px-4 py-3 font-medium tracking-wider text-right text-cyan-500 border-b border-white/5">
                    {isComposite ? 'Score' : 'MAE (Mean)'}
                </th>
                {!isComposite && (
                    <>
                        <th className="px-4 py-3 font-medium tracking-wider text-right border-b border-white/5">Std Err</th>
                        <th className="px-4 py-3 font-medium tracking-wider text-right border-b border-white/5">Bias</th>
                    </>
                )}
                <th className="px-4 py-3 font-medium tracking-wider text-right hidden sm:table-cell border-b border-white/5">n</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
                {validData.map((row, i) => {
                let rowClass = "group transition-all duration-200 hover:bg-white/5";
                let rankBadge = null;
                
                // Cinematic gradient backgrounds for top 3
                if (i === 0) {
                    rowClass += " bg-gradient-to-r from-yellow-500/10 to-transparent border-l-2 border-yellow-500";
                    rankBadge = <div className="flex items-center justify-center w-8 h-8 rounded-full bg-yellow-500/10 ring-1 ring-yellow-500/50 text-yellow-400 font-bold font-mono shadow-[0_0_15px_rgba(234,179,8,0.2)]">1</div>;
                } else if (i === 1) {
                    rowClass += " bg-gradient-to-r from-slate-400/10 to-transparent border-l-2 border-slate-400";
                    rankBadge = <div className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-400/10 ring-1 ring-slate-400/50 text-slate-300 font-bold font-mono shadow-[0_0_15px_rgba(148,163,184,0.2)]">2</div>;
                } else if (i === 2) {
                    rowClass += " bg-gradient-to-r from-orange-600/10 to-transparent border-l-2 border-orange-600";
                    rankBadge = <div className="flex items-center justify-center w-8 h-8 rounded-full bg-orange-600/10 ring-1 ring-orange-600/50 text-orange-400 font-bold font-mono shadow-[0_0_15px_rgba(234,88,12,0.2)]">3</div>;
                } else {
                    rowClass += " border-l-2 border-transparent hover:border-slate-700";
                    rankBadge = <div className="flex items-center justify-center w-8 h-8 text-slate-600 font-mono text-xs font-medium">{i + 1}</div>;
                }

                return (
                    <tr key={row.model} className={rowClass}>
                    <td className="px-4 py-3 whitespace-nowrap w-16">
                        {rankBadge}
                    </td>
                    <td className="px-4 py-3">
                        <div className={`font-semibold tracking-tight ${i === 0 ? 'text-yellow-100' : i === 1 ? 'text-slate-100' : i === 2 ? 'text-orange-100' : 'text-slate-300'}`}>
                            {modelDisplay(row.model)}
                        </div>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono font-bold text-base drop-shadow-sm ${isComposite ? 'text-yellow-400' : 'text-cyan-300'}`}>
                        {formatScore(row.avg_mae)}
                    </td>
                    {!isComposite && (
                        <>
                            <td className="px-4 py-3 text-right font-mono text-slate-500 text-xs">
                                {row.std_error ? `±${row.std_error.toFixed(3)}` : '-'}
                            </td>
                            <td className={`px-4 py-3 text-right font-mono font-medium ${row.avg_bias > 0 ? 'text-red-400' : row.avg_bias < 0 ? 'text-blue-400' : 'text-slate-500'}`}>
                                {formatBias(row.avg_bias)}
                            </td>
                        </>
                    )}
                    <td className="px-4 py-3 text-right font-mono text-slate-600 text-xs hidden sm:table-cell">
                        {row.total_verifications}
                    </td>
                    </tr>
                );
                })}
            </tbody>
            </table>
        </div>
      </div>
      
      {/* Legend / Explanation */}
      <div className="bg-slate-900/40 border border-white/5 rounded-xl p-4 backdrop-blur-sm shadow-lg">
         {isComposite ? (
             <div className="flex items-start gap-3 text-slate-400">
                 <div className="mt-1 p-1.5 bg-yellow-900/20 border border-yellow-500/20 rounded-md">
                    <Calculator className="h-4 w-4 text-yellow-500" />
                 </div>
                 <div className="text-xs space-y-1 flex-grow">
                    <h4 className="font-bold text-slate-200 uppercase tracking-wide mb-1">How the Overall Score Works</h4>
                    <p>The <strong className="text-yellow-400">Overall Score</strong> is a normalized performance index.</p>
                 </div>
             </div>
         ) : (
            <div className="flex items-start gap-3 text-slate-500">
                <div className="mt-1 p-1 bg-slate-800 rounded-md">
                    <Info className="h-3 w-3 text-slate-400" />
                </div>
                <div className="text-xs space-y-2 flex-grow">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
                        <p className="flex items-center gap-2"><span className="w-1 h-1 bg-cyan-500 rounded-full"></span><span><strong className="text-slate-300">MAE:</strong> Mean Abs Error</span></p>
                        <p className="flex items-center gap-2"><span className="w-1 h-1 bg-slate-500 rounded-full"></span><span><strong className="text-slate-300">Std Err:</strong> Standard Error (Confidence)</span></p>
                        <p className="flex items-center gap-2"><span className="w-1 h-1 bg-red-400 rounded-full"></span><span><strong className="text-slate-300">Bias (+):</strong> Over-forecast</span></p>
                        <p className="flex items-center gap-2"><span className="w-1 h-1 bg-blue-400 rounded-full"></span><span><strong className="text-slate-300">Bias (-):</strong> Under-forecast</span></p>
                    </div>
                </div>
            </div>
         )}
      </div>
    </div>
  );
};

export default LeaderboardTable;
