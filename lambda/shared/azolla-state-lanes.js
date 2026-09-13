// Manually-curated state lanes for the azolla state-transition graph
// (docs/specs/azolla-impact-power-model.md §9). Informed by, not replaced
// by, the emergent CLAIM_ATOMIC clustering exploration that surfaced these
// categories from real pilot-wide data (2026-09-05/06) — see the doc for
// the full reasoning trail.
//
// Each lane is independent (a "multi-lane" model, not one compound state):
// a container's full state at any observation is its position across every
// lane simultaneously. This avoids the combinatorial-explosion problem a
// single compound-node model would hit once more than a couple of
// independent dimensions exist.
//
// Every lane includes an explicit "not mentioned" value so every
// observation has a well-defined value on every lane (never silently
// missing), and every transition between two observations is well-formed.
const STATE_LANES = {
  azolla_condition: {
    label: 'Azolla condition',
    values: {
      struggling: 'Azolla is small, stuck, not growing, or struggling despite effort',
      thriving: 'Azolla is growing well, increasing in size or population, healthy',
      not_mentioned: 'Azolla condition was not mentioned in this observation',
    },
  },
  duckweed_condition: {
    label: 'Duckweed condition',
    values: {
      struggling: 'Duckweed is sparse, declining, or appears unhealthy',
      thriving: 'Duckweed is growing well, increasing in coverage or population, healthy',
      not_mentioned: 'Duckweed condition was not mentioned in this observation',
    },
  },
  manure: {
    label: 'Manure',
    values: {
      present: 'Chicken, cow, or carabao manure is present or was recently applied',
      not_mentioned: 'Manure was not mentioned in this observation',
    },
  },
  compost: {
    label: 'Compost',
    values: {
      present: 'Compost or vermicompost is present or was recently applied',
      not_mentioned: 'Compost was not mentioned in this observation',
    },
  },
  capacity: {
    label: 'Container capacity',
    values: {
      at_capacity: 'The container or tank is full, nearly full, or at capacity',
      not_mentioned: 'Container capacity was not mentioned in this observation',
    },
  },
  wildlife: {
    label: 'Wildlife/pest',
    values: {
      present: 'Frogs, tadpoles, mosquito larvae, ducks, or other animals are present',
      not_mentioned: 'Wildlife or pests were not mentioned in this observation',
    },
  },
  water_chemistry: {
    label: 'Water chemistry',
    values: {
      logged: 'A phosphorus, alkalinity, pH, or temperature measurement was recorded',
      not_mentioned: 'No water chemistry measurement was mentioned in this observation',
    },
  },
};

module.exports = { STATE_LANES };
