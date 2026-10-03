import React from 'react';
import { createRoot } from 'react-dom/client';
import { SynkProvider } from '@/entrypoints/options/state';
import { Popup } from '@/entrypoints/popup/popup';
import '@/entrypoints/popup/style.css';

createRoot(document.getElementById('root')!).render(
  <SynkProvider>
    <Popup />
  </SynkProvider>,
);
