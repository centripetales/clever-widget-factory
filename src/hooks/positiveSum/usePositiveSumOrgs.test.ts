import { describe, it, expect, vi } from 'vitest';
import { usePositiveSumOrgs } from './usePositiveSumOrgs';

const orgs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => ({ accessibleOrganizations: orgs.list }) }));

const withPositiveSum = { enabled_features: ['actions', 'positive_sum'] };
const without = { enabled_features: ['actions'] };
const POSITIVE_SUM = { id: 'ps', name: 'Positive Sum', settings: withPositiveSum };

describe('usePositiveSumOrgs', () => {
  it('includes a Positive Sum org the person belongs to directly', () => {
    orgs.list = [{ id: 'ps', name: 'Positive Sum', settings: withPositiveSum }, { id: 'sg', name: 'Stargazer Farm', settings: without }];
    expect(usePositiveSumOrgs()).toEqual([{ id: 'ps', name: 'Positive Sum' }]);
  });

  it('includes a Positive Sum org that the person\'s organization is a member of', () => {
    orgs.list = [{ id: 'sg', name: 'Stargazer Farm', settings: without, member_of: [POSITIVE_SUM, { id: 'coop', name: 'Co-op', settings: without }] }];
    expect(usePositiveSumOrgs()).toEqual([{ id: 'ps', name: 'Positive Sum' }]);
  });

  it('lists an org once when reached both ways', () => {
    orgs.list = [POSITIVE_SUM, { id: 'sg', name: 'Stargazer Farm', settings: without, member_of: [POSITIVE_SUM] }];
    expect(usePositiveSumOrgs()).toHaveLength(1);
  });
});
