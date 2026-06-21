export const actionsQueryKey = () => ['actions'];
export const completedActionsQueryKey = () => ['actions_completed'];
export const allActionsQueryKey = () => ['actions_all'];
export const actionQueryKey = (actionId: string) => ['action', actionId];
export const actionImplementationUpdatesQueryKey = (actionId: string) => ['action_implementation_updates', actionId];

// Exploration query keys
export const explorationsQueryKey = () => ['explorations'];
export const explorationQueryKey = (explorationId: number) => ['exploration', explorationId];
export const explorationByActionIdQueryKey = (actionId: string) => ['exploration_by_action', actionId];

export const toolsQueryKey = () => ['tools'];
export const partsQueryKey = () => ['parts'];

// Checkouts query key removed — checkout system deprecated

export const actionScoresQueryKey = (start?: string, end?: string) => [
  'action_scores',
  start ?? 'all',
  end ?? 'all',
];

export const proactiveReactiveQueryKey = (start?: string, end?: string) => [
  'proactiveReactive',
  start ?? 'all',
  end ?? 'all',
];

// Issues query keys removed - issue system deprecated

// Missions query keys
export const missionsQueryKey = () => ['missions'];

export const missionQueryKey = (missionId: string) => ['mission', missionId];

// Parts orders query key
export const partsOrdersQueryKey = (status?: string) => [
  'parts_orders',
  status ?? 'all'
];

// States query keys (org-scoped to prevent cross-org cache contamination)
// orgId is required so each organization has its own isolated cache slot.
export const statesQueryKey = (orgId: string, filters?: { entity_type?: string; entity_id?: string }) =>
  filters ? ['states', orgId, filters.entity_type ?? 'all', filters.entity_id ?? 'all'] : ['states', orgId];
export const stateQueryKey = (orgId: string, stateId: string) => ['state', orgId, stateId];

// Experiences query keys
export const experiencesQueryKey = (filters?: { entity_type?: string; entity_id?: string }) => 
  filters ? ['experiences', filters.entity_type ?? 'all', filters.entity_id ?? 'all'] : ['experiences'];
export const experienceQueryKey = (experienceId: string) => ['experience', experienceId];

// Capability query keys
export const capabilityProfileQueryKey = (actionId: string) => ['capability', actionId];
export const organizationCapabilityQueryKey = (actionId: string) => ['capability', actionId, 'organization'];

// State space model query keys
export const stateSpaceModelsQueryKey = () => ['state_space_models'];
export const stateSpaceModelQueryKey = (id: string) => ['state_space_model', id];
export const stateSpaceModelsByEntityQueryKey = (entityType: string, entityId: string) =>
  ['state_space_models_by_entity', entityType, entityId];

// Learning query keys
export const learningObjectivesQueryKey = (actionId: string, userId: string) =>
  ['learning_objectives', actionId, userId];

export const evaluationStatusQueryKey = (actionId: string, userId: string, stateIds: string[]) =>
  ['evaluation_status', actionId, userId, ...stateIds.sort()];

// Profile skills query keys
export const profileSkillsQueryKey = (userId?: string) =>
  userId ? ['profile_skills', userId] : ['profile_skills'];

// Member settings query keys
export const memberSettingsQueryKey = (userId: string, organizationId?: string) =>
  ['member-settings', userId, organizationId ?? 'default'];

// Organizations query keys
export const organizationsQueryKey = () => ['organizations'];


