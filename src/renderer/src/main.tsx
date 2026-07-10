import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyAnimPref } from './lib/animPref';
import { applyStoredCustomTheme } from './lib/customTheme';
import { applyThemePref } from './lib/themePref';
import './styles.css';

applyAnimPref();
applyThemePref();
// M27-6: カスタムテーマ(JSON)が保存されていれば標準テーマの上から復元する
applyStoredCustomTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
