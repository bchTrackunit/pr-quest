import './zodConfig.ts';
import '@fontsource/press-start-2p/latin-400.css';
import '../../platform/ui/styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
