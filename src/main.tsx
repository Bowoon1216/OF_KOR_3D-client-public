import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const rootElement = document.getElementById('root');

function showStartupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;padding:32px;font-family:ui-sans-serif,system-ui,sans-serif;background:#fff;color:#0f172a">
      <section style="max-width:720px;border:1px solid #e2e8f0;padding:24px">
        <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#2563eb">Startup error</p>
        <h1 style="margin:0 0 16px;font-size:24px">The app could not start</h1>
        <pre style="white-space:pre-wrap;overflow:auto;margin:0;background:#f8fafc;padding:16px;font-size:13px;line-height:1.5">${message}</pre>
      </section>
    </main>
  `;
}

try {
  if (!rootElement) {
    throw new Error('Missing #root element in index.html');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  showStartupError(error);
}
