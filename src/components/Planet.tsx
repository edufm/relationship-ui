import type { Entity } from '../model/types';

export const PLANET_RADIUS = 34;

/** Greedily wraps a label into short lines so it fits inside a planet circle, mirroring the multi-line labels in the original sketch. */
function wrapLabel(label: string, maxCharsPerLine = 9): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

interface PlanetProps {
  entity: Entity;
  x: number;
  y: number;
  opacity: number;
  isSelected: boolean;
  /** Synthetic "sem {tipo}" marker for a chain without a candidate — dashed, non-inspectable. */
  isPlaceholder?: boolean;
}

export function Planet({ entity, x, y, opacity, isSelected, isPlaceholder = false }: PlanetProps) {
  const lines = wrapLabel(entity.label);
  const lineHeight = 1.05;
  const startDy = -((lines.length - 1) * lineHeight) / 2;

  return (
    <g
      transform={`translate(${x} ${y})`}
      opacity={opacity}
      className={`planet${isSelected ? ' planet-selected' : ''}${isPlaceholder ? ' planet-placeholder' : ''}`}
      data-entity-id={entity.id}
    >
      <circle className="planet-circle" r={PLANET_RADIUS} />
      <text className="planet-label" textAnchor="middle">
        {lines.map((line, i) => (
          <tspan key={i} x={0} dy={i === 0 ? `${startDy}em` : `${lineHeight}em`}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}
