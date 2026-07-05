import { useState } from 'react';
import { dataset as sampleDataset } from './data/loadDataset';
import { OrbitProvider } from './state/OrbitContext';
import { OrbitExplorer } from './components/OrbitExplorer';
import { EntitySidebar } from './components/EntitySidebar';
import { DataSourceSetup, type DataSource } from './components/DataSourceSetup';
import './App.css';

const SAMPLE_RING_ORDER = ['continent', 'country', 'city', 'landmark'];

function App() {
  const [source, setSource] = useState<DataSource | null>(null);

  if (!source) {
    return <DataSourceSetup sample={{ dataset: sampleDataset, ringOrder: SAMPLE_RING_ORDER }} onLoaded={setSource} />;
  }

  return (
    <OrbitProvider
      key={`${source.dataset.name}:${source.ringOrder.join('|')}`}
      dataset={source.dataset}
      initialRingOrder={source.ringOrder}
    >
      <OrbitExplorer />
      <EntitySidebar />
      <button className="source-switch" onClick={() => setSource(null)}>
        ⟲ trocar fonte
      </button>
    </OrbitProvider>
  );
}

export default App;
