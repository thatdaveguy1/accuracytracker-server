
import React from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { BucketName, ModelVariableStats } from '../types';
import { BUCKET_LABELS, VARIABLE_LABELS, MODEL_LABELS } from '../constants';

interface LeaderboardChartProps {
  data: ModelVariableStats[];
  bucketName: BucketName;
  selectedVariable: string;
}

const LeaderboardChart: React.FC<LeaderboardChartProps> = ({ data, bucketName, selectedVariable }) => {
  const chartData = data
    .filter(d => d.variable === selectedVariable && d.n > 0) // Filter empty data
    .sort((a, b) => a.mae - b.mae) // Sort ascending by error (best first)
    .slice(0, 14) // Show top 14
    .map((d, i) => ({
      ...d,
      name: MODEL_LABELS[d.model_id] || d.model_id.toUpperCase(),
      rank: i
    }));
    // Note: Recharts vertical layout renders data top-to-bottom.
    // By sorting ascending by MAE, the best model (index 0) will correctly appear at the top.

  const getBarColor = (modelId: string, rankIndex: number) => {
    // The top 3 ranks get special colors
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
  
  const label = VARIABLE_LABELS[selectedVariable] || selectedVariable;
  const isOverall = selectedVariable === 'overall_score';

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
            margin={{ top: 0, right: 40, left: 10, bottom: 20 }}
            >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} horizontal={false} />
            
            <XAxis 
                type="number" 
                stroke="#64748b" 
                tick={{ fontSize: 11, fontFamily: 'JetBrains Mono' }}
                axisLine={false}
                tickLine={false}
                domain={isOverall ? [0, 'auto'] : ['auto', 'auto']} 
            />
            
            <YAxis 
                dataKey="name" 
                type="category" 
                stroke="#94a3b8" 
                width={130} 
                tick={{ fontSize: 11, fontWeight: 500, fill: '#cbd5e1' }} 
                axisLine={false}
                tickLine={false}
            />
            
            <Tooltip
                cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }}
                contentStyle={{ 
                    backgroundColor: '#0f172a', 
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)',
                    color: '#f1f5f9'
                }}
                itemStyle={{ color: '#f1f5f9', fontFamily: 'JetBrains Mono' }}
                labelStyle={{ color: '#94a3b8', marginBottom: '0.5rem', fontSize: '12px' }}
                formatter={(value: number) => [value.toFixed(3), isOverall ? 'Score' : 'MAE']}
            />
            
            <Bar dataKey="mae" radius={[0, 4, 4, 0]} barSize={20}>
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
