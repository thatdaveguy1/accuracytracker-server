
import React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { BucketName, ModelVariableStats } from '../types';
import { BUCKET_LABELS, VARIABLE_LABELS, MODEL_LABELS } from '../constants';
import { AlertCircle } from 'lucide-react';

interface LeaderboardChartProps {
    data: ModelVariableStats[];
    bucketName: BucketName;
    selectedVariable: string;
}

const LeaderboardChart: React.FC<LeaderboardChartProps> = ({ data, bucketName, selectedVariable }) => {
    // Filter and Sort Data
    const chartData = data
        .filter(d => d.variable === selectedVariable && d.n > 0) // Filter empty data
        .sort((a, b) => a.mae - b.mae) // Sort ascending by error (best first)
        .map((d, i) => ({
            ...d,
            name: MODEL_LABELS[d.model_id] || d.model_id.toUpperCase(),
            rank: i
        }));

    const label = VARIABLE_LABELS[selectedVariable] || selectedVariable;
    const isOverall = selectedVariable === 'overall_score';

    const getBarColor = (modelId: string, rankIndex: number) => {
        switch (rankIndex) {
            case 0: return '#eab308'; // Gold
            case 1: return '#94a3b8'; // Silver
            case 2: return '#ea580c'; // Bronze
        }
        if (modelId.includes('_of_models')) {
            return '#a78bfa'; // Purple for synthetic models
        }
        return '#334155'; // Default color
    };

    if (chartData.length === 0) {
        return (
            <div className="w-full h-full bg-slate-900/40 border border-white/10 rounded-2xl p-6 flex flex-col items-center justify-center backdrop-blur-md shadow-2xl text-center">
                <div className="p-4 bg-slate-800/50 rounded-full mb-3">
                    <AlertCircle className="h-8 w-8 text-slate-500" />
                </div>
                <h3 className="text-lg font-semibold text-slate-300">No Chart Data</h3>
                <p className="text-sm text-slate-500 mt-1 max-w-xs">
                    There are no valid stats for <span className="text-cyan-400">{label}</span> in the <span className="text-cyan-400">{BUCKET_LABELS[bucketName]}</span> window yet.
                </p>
            </div>
        );
    }

    return (
        <div className="w-full h-full bg-slate-900/40 border border-white/10 rounded-2xl p-6 flex flex-col backdrop-blur-md shadow-2xl">
            <div className="flex justify-between items-start mb-6">
                <div>
                    <h3 className="text-lg font-semibold text-white">Forecast Accuracy</h3>
                    <p className="text-sm text-slate-400">{label} • {BUCKET_LABELS[bucketName]} Lead Time</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <div className="text-[10px] font-mono font-bold text-emerald-400 bg-emerald-950/30 px-2 py-1 rounded border border-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.1)]">
                        SHORTER BAR = BETTER
                    </div>
                </div>
            </div>

            <div className="flex-grow">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                        data={chartData}
                        layout="vertical"
                        margin={{ top: 0, right: 30, left: 0, bottom: 10 }}
                    >
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} horizontal={false} />

                        <XAxis
                            type="number"
                            stroke="#64748b"
                            tick={{ fontSize: 10, fontFamily: 'JetBrains Mono' }}
                            axisLine={false}
                            tickLine={false}
                            domain={[0, 'auto']}
                        />

                        <YAxis
                            dataKey="name"
                            type="category"
                            stroke="#94a3b8"
                            width={110}
                            tick={{ fontSize: 10, fontWeight: 500, fill: '#cbd5e1' }}
                            axisLine={false}
                            tickLine={false}
                            interval={0} // Show all ticks
                        />

                        <Tooltip
                            cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
                            content={({ active, payload, label }) => {
                                if (active && payload && payload.length) {
                                    const data = payload[0].payload;
                                    return (
                                        <div className="bg-slate-900/95 border border-white/10 rounded-lg p-3 shadow-2xl backdrop-blur-sm">
                                            <p className="text-xs text-slate-400 mb-1 font-mono">{data.name}</p>
                                            <div className="flex items-baseline gap-2">
                                                <span className="text-lg font-bold text-white font-mono">
                                                    {data.mae.toFixed(3)}
                                                </span>
                                                <span className="text-[10px] text-slate-500 uppercase">
                                                    {isOverall ? 'SCORE' : 'MAE'}
                                                </span>
                                            </div>
                                            {!isOverall && (
                                                <div className="mt-2 pt-2 border-t border-white/5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono text-slate-400">
                                                    <span>RMSE: {data.rmse.toFixed(2)}</span>
                                                    <span className={data.bias > 0 ? 'text-red-400' : 'text-blue-400'}>
                                                        Bias: {data.bias > 0 ? '+' : ''}{data.bias.toFixed(2)}
                                                    </span>
                                                    <span>n: {data.n}</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                }
                                return null;
                            }}
                        />

                        <Bar dataKey="mae" radius={[0, 4, 4, 0]} barSize={16}>
                            {chartData.map((entry, index) => {
                                return (
                                    <Cell key={`cell-${index}`} fill={getBarColor(entry.model_id, entry.rank)} strokeWidth={0} />
                                );
                            })}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

export default LeaderboardChart;
