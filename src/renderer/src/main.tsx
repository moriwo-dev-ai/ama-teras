import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { applyAnimPref } from './lib/animPref';
import { applyStoredCustomTheme } from './lib/customTheme';
import { migrateLegacyLocalStorage } from './lib/legacyStorage';
import { applyThemePref } from './lib/themePref';
import './styles.css';

// M27-7: 旧称キー(mycodex-*)の一回きり移行。各Prefの読み出しより先に行う
migrateLegacyLocalStorage();
applyAnimPref();
applyThemePref();
// M27-6: カスタムテーマ(JSON)が保存されていれば標準テーマの上から復元する
applyStoredCustomTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
