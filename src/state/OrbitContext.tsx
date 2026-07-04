import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import type { Dataset } from '../model/types';
import {
  createInitialOrbitState,
  createOrbitReducer,
  type OrbitAction,
  type OrbitState,
} from './orbitState';

interface OrbitContextValue {
  state: OrbitState;
  dispatch: Dispatch<OrbitAction>;
  dataset: Dataset;
}

const OrbitContext = createContext<OrbitContextValue | null>(null);

export function OrbitProvider({
  dataset,
  initialRingOrder,
  children,
}: {
  dataset: Dataset;
  initialRingOrder: string[];
  children: ReactNode;
}) {
  const reducer = useMemo(() => createOrbitReducer(dataset), [dataset]);
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialOrbitState(dataset, initialRingOrder),
  );

  const value = useMemo(() => ({ state, dispatch, dataset }), [state, dispatch, dataset]);

  return <OrbitContext.Provider value={value}>{children}</OrbitContext.Provider>;
}

export function useOrbit(): OrbitContextValue {
  const ctx = useContext(OrbitContext);
  if (!ctx) throw new Error('useOrbit must be used within an OrbitProvider');
  return ctx;
}
