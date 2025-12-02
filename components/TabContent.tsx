
import React, { useState, useEffect, useRef } from 'react';
import type { BucketName, LeaderboardRow, ModelVariableStats } from '../types';
import { LEAD_TIME_BUCKETS } from '../constants';
import { apiClient } from '../services/apiClient';
import LeaderboardTable from './LeaderboardTable';
import LeaderboardChart from './LeaderboardChart';
import { Loader2, AlertTriangle, Database, Clock, Download } from 'lucide-react';

interface TabContentProps {
  bucketName: BucketName;
  selectedVariable: string;
}

const IconLoader = () => <Loader2 className="h-12 w-12 animate-spin text-cyan-500" />;
const IconError = () => <AlertTriangle className="h-12 w-12 text-red-400" />;

const TabContent: React.FC<TabContentProps> = ({ bucketName, selectedVariable }) => {
  const [leaderboardData, setLeaderboardData] = useState<LeaderboardRow[] | null>(null);
  const [chartData, setChartData] = useState<ModelVariableStats[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const requestRef = useRef<number>(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    const controller = new AbortController();

    const fetchData = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Pass signal to apiClient (requires apiClient update, but for now we just ignore result if aborted)
        const leaderboard = await apiClient.getLeaderboard(bucketName, selectedVariable);

        if (requestId === requestRef.current && !controller.signal.aborted) {
          setLeaderboardData(leaderboard);

          // Map leaderboard rows to chart data format
          const mappedChartData: ModelVariableStats[] = leaderboard.map(row => ({
            model_id: row.model,
            variable: selectedVariable,
            mae: row.avg_mae,
            mse: row.avg_mse,
            rmse: row.avg_rmse,
            bias: row.avg_bias,
            n: row.total_verifications,
            mape: null,
            correlation: null,
            index_of_agreement: null,
            skill_score: null,
            std_error: null
          }));
          setChartData(mappedChartData);
        }
      } catch (e) {
        if (requestId === requestRef.current && !controller.signal.aborted) {
          const errorMessage = e instanceof Error ? e.message : 'An unknown error occurred.';
          console.error(`Failed to fetch data for tab ${bucketName}:`, e);
          setError(`Failed to load data. ${errorMessage}`);
        }
      } finally {
        if (requestId === requestRef.current && !controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    fetchData();

    return () => {
      controller.abort();
    };
  }, [bucketName, selectedVariable]);

  const handleExport = async () => {
    // TODO: Implement server-side export or client-side CSV generation from current data
    alert("Export functionality to be restored via server API.");
  };

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

        <div className="mt-8 bg-slate-950/50 border border-white/10 rounded-xl p-4 flex flex-col items-center gap-2 min-w-[300px] opacity-60">
          <div className="flex items-center gap-2 text-slate-500 text-xs font-mono uppercase tracking-widest mb-1">
            <Clock className="h-3 w-3" />
            System Status
          </div>
          <p className="text-xs text-slate-600 font-mono mt-1">
            Data collection in progress...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={handleExport}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono text-slate-400 hover:text-white bg-slate-800/50 hover:bg-slate-800 rounded border border-white/10 hover:border-cyan-500/50 transition-all"
        >
          <Download className="h-3 w-3" />
          EXPORT CSV
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-7 h-[500px] xl:h-[600px]">
          <LeaderboardChart data={chartData} bucketName={bucketName} selectedVariable={selectedVariable} />
        </div>
        <div className="xl:col-span-5">
          <LeaderboardTable data={leaderboardData} isComposite={selectedVariable === 'overall_score'} />
        </div>
      </div>
    </div>
  );
};

export default TabContent;
