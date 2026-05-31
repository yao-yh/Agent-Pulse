import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';

export function Root({ queryClient }: { queryClient: QueryClient }) {
  return (
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>
  );
}

