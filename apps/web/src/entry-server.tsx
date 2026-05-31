import { renderToString } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { Root } from './Root';
import './styles.css';

export function render(_url: string): string {
  return renderToString(<Root queryClient={new QueryClient()} />);
}

