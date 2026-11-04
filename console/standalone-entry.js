import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorldConsole, flattenDictionary } from './view.js';
import { consumeOperatorFragment } from './operator-client.js';
import dictionaries from './dictionaries.js';
import './standalone.css';

// The sole persistent browser value is the operator access code. Consume it
// before mounting and remove even a malformed matching fragment immediately.
consumeOperatorFragment({ location: window.location, history: window.history, storage: {
  setItem: (key, value) => window.sessionStorage.setItem(key, value),
} });
const zh = flattenDictionary(dictionaries.zh), en = flattenDictionary(dictionaries.en);
const t = key => zh[key] || en[key] || key;
createRoot(document.getElementById('app')).render(React.createElement(WorldConsole, { t, standalone: true }));
