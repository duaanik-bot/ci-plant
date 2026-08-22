import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Keep the push worker current on every boot. Registering an ALREADY-registered
// worker is a no-op that also picks up a new sw.js after a deploy, so a phone
// that agreed to be buzzed months ago keeps working without being asked again.
// It never prompts: permission was granted (or not) in the Notification Center,
// and this only re-attaches the worker behind that decision.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}
