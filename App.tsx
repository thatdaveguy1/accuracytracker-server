
import React, { useState, useEffect, useRef } from 'react';
import { useWeatherTracker } from './hooks/useWeatherTracker';
import Dashboard from './components/Dashboard';
import { Loader2, Terminal, Activity, Clock, Radio } from 'lucide-react';

const App: React.FC = () => {
  const { status, lastUpdated, logs, isInitialized } = useWeatherTracker();
  const [showLogs, setShowLogs] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, showLogs]);
  
  const IconLoader = () => <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />;
  
  // Status Indicator Logic
  const getStatusColor = () => {
    if (status === 'Idle') return 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]';
    if (status === 'Error') return 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]';
    return 'bg-amber-500 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.5)]';
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header / HUD Top Bar */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-slate-950/80 border-b border-white/5 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="bg-gradient-to-br from-cyan-500/20 to-blue-500/10 p-2.5 rounded-xl border border-white/10 shadow-[0_0_15px_rgba(34,211,238,0.15)]">
              <Activity className="h-6 w-6 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight font-sans">
                CYEG <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">ModelTracker</span>
              </h1>
              <p className="text-[10px] text-slate-400 font-mono uppercase tracking-[0.2em]">Forecast Verification • Edmonton</p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
             <div className="flex items-center gap-3 bg-slate-900/80 px-3 py-1.5 rounded-full border border-white/10 shadow-inner">
                <div className={`h-2 w-2 rounded-full ${getStatusColor()}`} />
                <span className="text-[10px] font-mono font-bold text-slate-300 uppercase tracking-widest">{status}</span>
                {status !== 'Idle' && <IconLoader />}
             </div>
             <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                <Clock className="h-3 w-3 opacity-50" />
                <span>LAST UPDATE: {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : 'WAITING...'}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow container max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isInitialized ? (
          <div className="animate-in fade-in duration-700 slide-in-from-bottom-4">
            <Dashboard />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-[60vh] border border-white/5 rounded-2xl bg-slate-900/30 backdrop-blur-sm">
            <div className="relative">
                <div className="absolute inset-0 bg-cyan-500/20 blur-2xl rounded-full animate-pulse"></div>
                <Radio className="h-16 w-16 text-cyan-400 relative z-10 animate-pulse" />
            </div>
            <h2 className="mt-8 text-2xl font-light text-white tracking-wide">Initializing Systems</h2>
            <p className="mt-2 text-slate-500 font-mono text-xs uppercase tracking-widest">{status}...</p>
          </div>
        )}
      </main>
      
      {/* Terminal Footer */}
      <footer className="border-t border-white/10 bg-slate-950/80 backdrop-blur-md mt-auto relative z-50">
        <div className="max-w-7xl mx-auto">
            <button 
                onClick={() => setShowLogs(!showLogs)}
                className="w-full flex items-center justify-between p-3 text-xs font-mono text-slate-400 hover:text-cyan-400 hover:bg-white/5 transition-colors focus:outline-none border-b border-transparent"
            >
                <span className="flex items-center gap-2">
                    <Terminal className="h-3.5 w-3.5" />
                    SYSTEM LOGS
                </span>
                <span className="uppercase tracking-wider opacity-50 text-[10px]">
                    [{showLogs ? 'COLLAPSE' : 'EXPAND'}]
                </span>
            </button>
            
            {showLogs && (
                <div 
                    ref={logsContainerRef} 
                    className="h-64 overflow-y-auto p-4 bg-black/90 font-mono text-xs text-emerald-500/80 shadow-inner custom-scrollbar"
                >
                    {logs.map((log, index) => (
                        <div key={index} className="mb-1 flex gap-2">
                            <span className="opacity-30 select-none">{'>'}</span>
                            <p className="break-words">{log}</p>
                        </div>
                    ))}
                    <div className="animate-pulse mt-2 select-none">_</div>
                </div>
            )}
        </div>
      </footer>
    </div>
  );
};

export default App;
