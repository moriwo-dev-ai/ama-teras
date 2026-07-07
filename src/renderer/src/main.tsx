import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyAnimPref } from './lib/animPref';
import { applyThemePref } from './lib/themePref';
import './styles.css';

applyAnimPref();
applyThemePref();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
