import { hydrateRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { Root } from './Root';
import 'antd/dist/reset.css';
import './styles.css';

hydrateRoot(document.getElementById('root')!, <Root queryClient={new QueryClient()} />);

