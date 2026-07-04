import { dataset } from './data/loadDataset';
import { OrbitProvider } from './state/OrbitContext';
import { OrbitExplorer } from './components/OrbitExplorer';
import './App.css';

const INITIAL_RING_ORDER = ['category', 'continent', 'country', 'city', 'landmark'];

function App() {
  return (
    <OrbitProvider dataset={dataset} initialRingOrder={INITIAL_RING_ORDER}>
      <OrbitExplorer />
    </OrbitProvider>
  );
}

export default App;
