import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyAnimPref } from './lib/animPref';
import './styles.css';

applyAnimPref();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
