import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCombinedAssets } from '../hooks/useCombinedAssets';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    organization: { id: 'org-1' },
    accessibleOrganizations: [{ id: 'org-1' }, { id: 'org-2' }],
    loading: false,
  }),
}));

vi.mock('@/hooks/useSharedOrgs', () => ({
  useSharedOrgs: () => ({
    selectedOrgs: ['org-2'],
  }),
}));

describe('useCombinedAssets debug', () => {
  it('should print config objects', () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useCombinedAssets(), { wrapper });
  });
});
