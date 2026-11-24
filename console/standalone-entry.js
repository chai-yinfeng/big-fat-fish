import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorldConsole, flattenDictionary } from './view.js';
import { consumeOperatorFragment } from './operator-client.js';
import dictionaries from './dictionaries.js';
import './standalone.css';

// The persistent browser values are the operator access code (and the room's local port). Consume it
// before mounting and remove even a malformed matching fragment immediately.
consumeOperatorFragment({ location: window.location, history: window.history, storage: {
  setItem: (key, value) => window.sessionStorage.setItem(key, value),
  removeItem: key => window.sessionStorage.removeItem(key),
} });
// Apply a remembered light/dark override before the first render; system preference otherwise.
try { const theme = window.localStorage.getItem('companion-world:theme'); if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme); } catch {}
const zh = flattenDictionary(dictionaries.zh), en = flattenDictionary(dictionaries.en);
const t = key => zh[key] || en[key] || key;
createRoot(document.getElementById('app')).render(React.createElement(WorldConsole, { t, standalone: true }));
