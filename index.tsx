import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  const errorMsg = "CRITICAL SYSTEM ERROR: Root element not found. Application cannot mount.";
  console.error(errorMsg);
  document.body.innerHTML = `<div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0f172a;color:#ef4444;font-family:'Courier New',monospace;flex-direction:column;text-align:center;padding:20px;">
    <h2 style="margin:0 0 10px 0;">System Failure</h2>
    <p style="margin:0;opacity:0.8;">${errorMsg}</p>
  </div>`;
  throw new Error(errorMsg);
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);