import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadTheme } from './theme';
import './styles.css';

applyTheme(loadTheme());

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root が無い');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
