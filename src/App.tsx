import { useState } from 'react';
import { dataset as sampleDataset } from './data/loadDataset';
import { OrbitProvider, useOrbit } from './state/OrbitContext';
import { OrbitExplorer } from './components/OrbitExplorer';
import { EntitySidebar } from './components/EntitySidebar';
import { DataSourceSetup, type DataSource } from './components/DataSourceSetup';
import './App.css';

const SAMPLE_RING_ORDER = ['continent', 'country', 'city', 'landmark'];

/** Chips to restore rings hidden via the × on their axis label. */
function HiddenRingChips() {
  const { state, dataset, dispatch } = useOrbit();
  if (state.hiddenRings.length === 0) return null;
  return (
    <div className="hidden-rings">
      <span className="hidden-rings-caption">ocultas:</span>
      {state.hiddenRings.map(({ typeId }) => (
        <button
          key={typeId}
          className="hidden-ring-chip"
          onClick={() => dispatch({ type: 'SHOW_RING', typeId })}
          title="Mostrar órbita novamente"
        >
          + {dataset.entityTypes.find((t) => t.id === typeId)?.label ?? typeId}
        </button>
      ))}
    </div>
  );
}

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
      <HiddenRingChips />
      <button className="source-switch" onClick={() => setSource(null)}>
        ⟲ trocar fonte
      </button>
    </OrbitProvider>
  );
}

export default App;
