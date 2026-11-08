'use strict';

const { z } = require('zod');
const { parse } = require('mathjs');

// --- Zod Schemas (mirrors src/lib/stateSpaceSchema.ts for nonlinear format) ---

const modelMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
  author: z.string(),
  description: z.string(),
});

const constantsSchema = z.record(
  z.string(),
  z.object({
    value: z.number(),
    name: z.string(),
    unit: z.string(),
  })
);

const stateDefinitionsSchema = z.record(
  z.string(),
  z.object({
    id: z.string(),
    name: z.string(),
    unit: z.string(),
    default_value: z.number(),
  })
);

const inputVectorsSchema = z.object({
  u_actuators: z.record(z.string(), z.string()),
  v_shocks: z.record(z.string(), z.string()),
});

const nonLinearTransitionsSchema = z.record(z.string(), z.string());

const stateUpdateEquationsSchema = z.record(z.string(), z.string());

const simulationConfigSchema = z.object({
  dt: z.number().positive(),
  total_days: z.number().positive(),
});

const nonlinearModelSchema = z.object({
  model_metadata: modelMetadataSchema,
  model_description_prompt: z.string(),
  constants: constantsSchema,
  state_definitions: stateDefinitionsSchema,
  input_vectors: inputVectorsSchema,
  non_linear_transitions: nonLinearTransitionsSchema,
  state_update_equations: stateUpdateEquationsSchema,
  simulation_config: simulationConfigSchema,
});


// --- Cross-Reference Validation ---

/**
 * Validates that state_update_equations keys and state_definitions keys
 * are consistent: every equation key K_next must have a corresponding K
 * in state_definitions, and every state K must have a K_next equation.
 *
 * Requirements: 2.1, 2.2, 2.3
 */
function validateCrossReferences(model) {
  const errors = [];
  const stateKeys = new Set(Object.keys(model.state_definitions));
  const equationKeys = new Set(Object.keys(model.state_update_equations));

  // Every equation key K_next must have K in state_definitions
  for (const eqKey of equationKeys) {
    const stateKey = eqKey.replace(/_next$/, '');
    if (!stateKeys.has(stateKey)) {
      errors.push(
        `Orphaned equation key "${eqKey}": no corresponding "${stateKey}" in state_definitions`
      );
    }
  }

  // Every state key K must have K_next in state_update_equations
  for (const stateKey of stateKeys) {
    const expectedEqKey = `${stateKey}_next`;
    if (!equationKeys.has(expectedEqKey)) {
      errors.push(
        `Missing equation for state "${stateKey}": expected "${expectedEqKey}" in state_update_equations`
      );
    }
  }

  return errors;
}

// --- Expression Validation ---

/** mathjs built-in functions/constants that should not be flagged as undefined variables */
const MATHJS_BUILTINS = new Set([
  'exp', 'max', 'min', 'abs', 'sqrt', 'log',
  'sin', 'cos', 'tan', 'pow', 'ceil', 'floor', 'round',
  'pi', 'e',
]);

/**
 * Extract variable references from a mathjs expression string.
 * Parses the AST and collects all SymbolNode names, filtering out
 * mathjs built-in functions and constants.
 */
function extractVariables(expr) {
  const tree = parse(expr);
  const symbols = [];
  tree.traverse((node) => {
    if (node.type === 'SymbolNode' && node.name && !MATHJS_BUILTINS.has(node.name)) {
      symbols.push(node.name);
    }
  });
  return symbols;
}

/**
 * Validates all expressions in non_linear_transitions and state_update_equations.
 * Checks for:
 * 1. Syntax validity (mathjs.parse)
 * 2. Variable reference resolution against the valid scope
 *
 * Requirements: 2.4, 2.5, 3.1, 3.2, 3.3, 3.4
 */
function validateExpressions(model) {
  const errors = [];

  const constantKeys = Object.keys(model.constants);
  const stateKeys = Object.keys(model.state_definitions);
  const actuatorKeys = Object.keys(model.input_vectors.u_actuators);
  const shockKeys = Object.keys(model.input_vectors.v_shocks);
  const transitionKeys = Object.keys(model.non_linear_transitions);

  // Base scope shared by both transitions and equations
  const baseScope = new Set([
    ...constantKeys,
    ...stateKeys,
    ...actuatorKeys,
    ...shockKeys,
    'dt',
    't',
  ]);

  // Validate non_linear_transitions (previously declared keys only)
  const declaredTransitions = new Set();
  for (const [key, expr] of Object.entries(model.non_linear_transitions)) {
    // Phase 1: Syntax check
    try {
      parse(expr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Parse error';
      errors.push(`Expression "${key}": ${msg}`);
      declaredTransitions.add(key);
      continue;
    }

    // Phase 2: Variable reference check
    const scope = new Set([...baseScope, ...declaredTransitions]);
    const vars = extractVariables(expr);
    for (const v of vars) {
      if (!scope.has(v)) {
        errors.push(`Expression "${key}": undefined variable "${v}"`);
      }
    }

    declaredTransitions.add(key);
  }

  // Validate state_update_equations (all transition keys in scope)
  const equationScope = new Set([...baseScope, ...transitionKeys]);
  for (const [key, expr] of Object.entries(model.state_update_equations)) {
    // Phase 1: Syntax check
    try {
      parse(expr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Parse error';
      errors.push(`Expression "${key}": ${msg}`);
      continue;
    }

    // Phase 2: Variable reference check
    const vars = extractVariables(expr);
    for (const v of vars) {
      if (!equationScope.has(v)) {
        errors.push(`Expression "${key}": undefined variable "${v}"`);
      }
    }
  }

  return errors;
}


// --- Expectation Models ---
// What a metric is expected to do over time: random variables whose
// parameters are formulas of t (days since the anchor date), of other
// variables in the same step, and of a variable's own previous value
// (<name>_prev, from its `initial` at t = 0).

const DISTRIBUTION_PARAMS = {
  fixed: ['value'],
  normal: ['mean', 'sd'],
  lognormal: ['mu', 'sigma'],
  poisson: ['lambda'],
  binomial: ['n', 'p'],
  bernoulli: ['p'],
};

const expectationVariableSchema = z.object({
  name: z.string().min(1),
  unit: z.string().optional(),
  distribution: z.enum(Object.keys(DISTRIBUTION_PARAMS)),
  params: z.record(z.string(), z.union([z.number(), z.string()])),
  initial: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  metric_id: z.string().optional(),
});

const expectationModelSchema = z.object({
  kind: z.literal('expectation'),
  model_metadata: modelMetadataSchema,
  anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date, YYYY-MM-DD'),
  time_step_days: z.number().positive(),
  horizon_days: z.number().positive(),
  variables: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and _'), expectationVariableSchema)
    .refine((v) => Object.keys(v).length > 0, 'at least one variable'),
  rationale: z.string().min(1),
  evidence: z.object({
    summary: z.string().min(1),
    observation_ids: z.array(z.string()).default([]),
    experience_ids: z.array(z.string()).default([]),
  }),
});

// Names an expression refers to, apart from the functions it calls.
function referencedNames(expr) {
  const names = [];
  parse(expr).traverse((node, path, parent) => {
    if (node.type === 'SymbolNode' && !(parent?.type === 'FunctionNode' && path === 'fn')) names.push(node.name);
  });
  return names;
}

function validateExpectationModel(jsonBody) {
  const result = expectationModelSchema.safeParse(jsonBody);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`),
    };
  }
  const model = result.data;
  const keys = Object.keys(model.variables);
  const errors = [];
  const uses = {};

  for (const [key, v] of Object.entries(model.variables)) {
    const expected = DISTRIBUTION_PARAMS[v.distribution];
    const given = Object.keys(v.params);
    if (expected.some((p) => !given.includes(p)) || given.some((p) => !expected.includes(p))) {
      errors.push(`variables.${key}: ${v.distribution} takes ${expected.join(', ')}`);
    }
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) errors.push(`variables.${key}: min is above max`);
    uses[key] = new Set();
    for (const [param, expr] of Object.entries(v.params)) {
      if (typeof expr === 'number') continue;
      let names;
      try {
        names = referencedNames(expr);
      } catch (e) {
        errors.push(`variables.${key}.params.${param}: ${e instanceof Error ? e.message : 'Parse error'}`);
        continue;
      }
      for (const n of names) {
        const lagged = n.endsWith('_prev') ? n.slice(0, -'_prev'.length) : null;
        if (n === 't' || n === 'pi' || n === 'e') continue;
        if (keys.includes(n)) uses[key].add(n);
        else if (lagged && model.variables[lagged]?.initial !== undefined) continue;
        else if (lagged && keys.includes(lagged)) errors.push(`variables.${key}.params.${param}: ${n} needs an initial value on ${lagged}`);
        else errors.push(`variables.${key}.params.${param}: undefined variable "${n}"`);
      }
    }
  }

  // Within a step, variables can use each other only without a loop;
  // feedback goes through time (<name>_prev).
  const state = {};
  const visit = (key, trail) => {
    if (state[key] === 'done') return;
    if (state[key] === 'visiting') {
      errors.push(`variables depend on each other in a loop within a step: ${[...trail, key].join(' → ')}; use <name>_prev for feedback`);
      return;
    }
    state[key] = 'visiting';
    for (const dep of uses[key]) visit(dep, [...trail, key]);
    state[key] = 'done';
  };
  for (const key of keys) if (!state[key]) visit(key, []);

  return errors.length > 0 ? { success: false, errors: [...new Set(errors)] } : { success: true, model };
}


// --- Combined Validation Entry Point ---

/**
 * Validates a parsed JSON body as a NonlinearModel.
 * Runs Zod schema validation, then cross-reference validation,
 * then expression syntax/variable validation.
 *
 * @param {object} jsonBody - The parsed JSON object to validate
 * @returns {{ success: true, model: object } | { success: false, errors: string[] }}
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */
function validateStateSpaceModel(jsonBody) {
  if (jsonBody?.kind === 'expectation') return validateExpectationModel(jsonBody);

  // Phase 1: Zod schema validation
  const result = nonlinearModelSchema.safeParse(jsonBody);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    return { success: false, errors };
  }

  // Phase 2: Cross-reference validation
  const crossRefErrors = validateCrossReferences(result.data);
  if (crossRefErrors.length > 0) {
    return { success: false, errors: crossRefErrors };
  }

  // Phase 3: Expression syntax and variable validation
  const exprErrors = validateExpressions(result.data);
  if (exprErrors.length > 0) {
    return { success: false, errors: exprErrors };
  }

  return { success: true, model: result.data };
}

module.exports = {
  nonlinearModelSchema,
  validateCrossReferences,
  validateExpressions,
  validateStateSpaceModel,
  validateExpectationModel,
};
