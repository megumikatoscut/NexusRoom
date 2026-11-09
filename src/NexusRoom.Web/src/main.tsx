import { createRoot } from 'react-dom/client';
import App from './App';
import { Provider } from './context';
import { CommunicationProvider } from './communication/context';
import './styles.css';
createRoot(document.getElementById('root')!).render(<Provider><CommunicationProvider><App/></CommunicationProvider></Provider>);
