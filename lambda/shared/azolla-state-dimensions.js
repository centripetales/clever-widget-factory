// The observable-state taxonomy for the azolla state-transition graph
// (docs/specs/azolla-impact-power-model.md §9). Every dimension here was
// deliberately chosen to be judgable from a photo alone, without lab
// equipment (phosphorus, "15-day doubling time" and similar root-cause/
// computed-rate concepts were considered and rejected — see the doc), and
// decomposed into raw attributes rather than evaluative labels ("healthy"
// was rejected for both azolla and duckweed in favor of color/size/texture
// people can point at directly).
//
// A "state" for the graph is the combination of whichever of these apply to
// a given observation, not a single flat category. v1 classification is
// human-judged (a person picks the values that apply), not AI-classified.
const STATE_DIMENSIONS = {
  azolla_color: {
    label: 'Azolla color',
    values: ['dark_green', 'light_green', 'yellow', 'red_brown'],
  },
  azolla_size: {
    label: 'Azolla size',
    values: ['small', 'large'], // small = <1cm, large = >1cm
  },
  azolla_texture: {
    label: 'Azolla texture',
    values: ['fluffy_full', 'flat_wilted'],
  },
  trend: {
    label: 'Trend',
    values: ['increasing', 'stable', 'decreasing'], // azolla growth trend
  },
  duckweed_color: {
    label: 'Duckweed color',
    values: ['green', 'pale'],
  },
  duckweed_spots: {
    label: 'Duckweed spots',
    values: ['present', 'absent'],
  },
  water_color: {
    label: 'Water color',
    values: ['clear', 'green', 'brown'],
  },
};

// Not a dimension a person picks — the explicit fallback node for a state
// with no STATE_OBSERVATION_TAGS row yet, so it shows up on the graph
// instead of silently disappearing.
const UNCLASSIFIED = 'unclassified';

module.exports = { STATE_DIMENSIONS, UNCLASSIFIED };
