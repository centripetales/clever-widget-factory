import { describe, it, expect, vi } from 'vitest';
import { useFeatureFlag } from '../hooks/useFeatureFlag';

// Mock useOrganization
const mockUseOrganization = vi.fn();
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => mockUseOrganization(),
}));

describe('useFeatureFlag', () => {
  it('should enable all features by default if organization is not set', () => {
    mockUseOrganization.mockReturnValue({ organization: null });
    const { isFeatureEnabled } = useFeatureFlag();
    expect(isFeatureEnabled('any-feature')).toBe(true);
    expect(isFeatureEnabled()).toBe(true);
  });

  it('should enable all features by default if enabled_features is not defined', () => {
    mockUseOrganization.mockReturnValue({
      organization: { id: 'org-1', settings: {} },
    });
    const { isFeatureEnabled } = useFeatureFlag();
    expect(isFeatureEnabled('any-feature')).toBe(true);
  });

  it('should filter features based on enabled_features array', () => {
    mockUseOrganization.mockReturnValue({
      organization: {
        id: 'org-1',
        settings: {
          enabled_features: ['observations', 'assets'],
        },
      },
    });
    const { isFeatureEnabled } = useFeatureFlag();
    expect(isFeatureEnabled('observations')).toBe(true);
    expect(isFeatureEnabled('assets')).toBe(true);
    expect(isFeatureEnabled('actions')).toBe(false);
  });

  it('should always allow core features without featureKey', () => {
    mockUseOrganization.mockReturnValue({
      organization: {
        id: 'org-1',
        settings: {
          enabled_features: ['observations'],
        },
      },
    });
    const { isFeatureEnabled } = useFeatureFlag();
    expect(isFeatureEnabled(undefined)).toBe(true);
    expect(isFeatureEnabled('')).toBe(true);
  });
});
