import { dataset } from './data/loadDataset';
import { OrbitProvider } from './state/OrbitContext';
import { OrbitExplorer } from './components/OrbitExplorer';
import { EntitySidebar } from './components/EntitySidebar';
import './App.css';

const INITIAL_RING_ORDER = ['continent', 'country', 'city', 'landmark'];

function App() {
  return (
    <OrbitProvider dataset={dataset} initialRingOrder={INITIAL_RING_ORDER}>
      <OrbitExplorer />
      <EntitySidebar />
    </OrbitProvider>
  );
}

export default App;
