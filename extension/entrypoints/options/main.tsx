import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from '@/entrypoints/options/router';
import '@/entrypoints/options/style.css';

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
