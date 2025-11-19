
import React, { useState, useEffect, useRef } from 'react';
import type { BucketName, LeaderboardRow, ModelVariableStats } from '../types';
import { LEAD_TIME_BUCKETS } from '../constants';
import * as weatherService from '../services/weatherService';
import LeaderboardTable from './LeaderboardTable';
import LeaderboardChart from './LeaderboardChart';
import { Loader2, AlertTriangle, Database, Clock } from 'lucide-react';

interface TabContentProps {
  bucketName: BucketName;
  selectedVariable: string;
}

const TabContent: React.FC<TabContentProps> = ({ bucketName, selectedVariable }) => {
  const [leaderboardData, setLeaderboardData] = useState<LeaderboardRow[] | null>(null);
  const [chartData, setChartData] = useState<ModelVariableStats[] | null>(null);
  const [eta, setEta] = useState<{ targetTime: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Fix: Race Condition Handling
  const requestRef = useRef<number>(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      setEta(null);
      try {
        // Fetch Table Data
        const leaderboard = await weatherService.getLeaderboardDataForBucket(bucketName, selectedVariable);
        
        // Fetch Chart Data
        let statsForChart;
        if (selectedVariable === 'overall_score') {
            statsForChart = await weatherService.calculateCompositeStats(bucketName);
        } else {
            statsForChart = await weatherService.calculateModelVariableStats(bucketName);
        }

        // Only update state if this request is still the latest one
        if (requestId === requestRef.current) {
            setLeaderboardData(leaderboard);
            setChartData(statsForChart);
            
            if (!leaderboard || leaderboard.length === 0) {
                const earliestIssue = await weatherService.getEarliestIssueTime();
                if (earliestIssue) {
                    const minHours = LEAD_TIME_BUCKETS[bucketName][0];
                    const target = earliestIssue + (minHours * 3600 * 1000);
                    setEta({ targetTime: target });
                }
            }
        }
      } catch (e) {
        if (requestId === requestRef.current) {
            const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred.';
            console.error(`Failed to fetch data for tab ${bucketName}:`, e);
            setError(`Failed to load data. ${errorMessage}`);
        }
      } finally {
        if (requestId === requestRef.current) {
            setIsLoading(false);
        }
      }
    };

    fetchData();
    
    return () => {
        // Cleanup not strictly necessary with ref check, but good practice
    };
  }, [bucketName, selectedVariable]);
  
  const IconLoader = () => <Loader2 className="h-12 w-12 animate-spin text-cyan-500" />;
  const IconError = () => <AlertTriangle className="h-12 w-12 text-red-400" />;

  if (isLoading) {
    return (
        <div className="flex flex-col justify-center items-center h-96 bg-slate-900/20 border border-white/5 rounded-2xl backdrop-blur-sm">
            <IconLoader />
            <p className="mt-4 text-slate-400 font-mono text-sm animate-pulse">Crunching numbers...</p>
        </div>
    );
  }
  
  if (error) {
    return (
      <div className="bg-red-950/30 border border-red-500/20 p-12 rounded-2xl text-center flex flex-col items-center backdrop-blur-md">
        <IconError />
        <p className="mt-6 text-xl text-red-200 font-medium">System Malfunction</p>
        <p className="text-red-300/70 text-sm mt-2 font-mono">{error}</p>
      </div>
    );
  }

  if (!leaderboardData || !chartData || leaderboardData.length === 0) {
    return (
      <div className="bg-slate-900/30 border border-white/5 border-dashed p-16 rounded-2xl text-center flex flex-col items-center backdrop-blur-md">
        <div className="p-4 bg-slate-800/50 rounded-full mb-4">
            <Database className="h-8 w-8 text-slate-500" />
        </div>
        <p className="text-lg text-slate-200 font-medium">Insufficient Data</p>
        <p className="text-slate-400 text-sm mt-2 max-w-md mx-auto">
            Waiting for more data to generate valid verification metrics for this lead time.
        </p>
        {eta && (
            <div className="mt-8 bg-slate-950/50 border border-white/10 rounded-xl p-4 flex flex-col items-center gap-2 min-w-[300px]">
                <div className="flex items-center gap-2 text-cyan-400 text-xs font-mono uppercase tracking-widest mb-1">
                    <Clock className="h-3 w-3" />
                    Data Status
                </div>
                <p className="text-2xl font-bold text-white font-mono">
                    {new Date(eta.targetTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </p>
                <p className="text-xs text-slate-500 font-mono">
                    {new Date(eta.targetTime).toLocaleDateString()}
                </p>
                <div className="h-px w-full bg-white/5 my-2"></div>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider">
                    {eta.targetTime > Date.now() ? (
                        `Incoming in ${Math.ceil((eta.targetTime - Date.now()) / (3600 * 1000))} Hours`
                    ) : (
                        'Pending next update cycle...'
                    )}
                </p>
            </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
      <div className="xl:col-span-7 h-[500px] xl:h-[600px]">
        <LeaderboardChart data={chartData} bucketName={bucketName} selectedVariable={selectedVariable} />
      </div>
      <div className="xl:col-span-5">
        <LeaderboardTable data={leaderboardData} isComposite={selectedVariable === 'overall_score'} />
      </div>
    </div>
  );
};

export default TabContent;
