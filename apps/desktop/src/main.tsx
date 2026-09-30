import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startE2EDriver } from './e2eDriver';
import './styles.css';

startE2EDriver(); // inert unless the shell injected window.__JARVIS_E2E__ (env-gated)

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
