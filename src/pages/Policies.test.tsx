import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Policies from './Policies';
import { apiService } from '@/lib/apiService';
import type { Policy } from '@/types/policies';

let role = 'admin';
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({ organization: { id: 'org-1' }, organizationMember: { role } }),
}));
vi.mock('@/lib/apiService', () => ({
  apiService: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  errorMessage: (error: Error) => error.message,
}));

const fueling: Policy = {
  id: 'p-fuel', title: 'Fueling a vehicle', description_text: 'Purchase a full tank.', reasoning: 'To track km/l.',
  status: 'active', action_count: 189, sources: [],
};
const wine: Policy = {
  id: 'p-wine', title: 'Making bignay wine', description_text: 'Use ripe fruit.', reasoning: null, status: 'active', action_count: 0,
  sources: [
    { type: 'observation', id: 'obs-1', text: '<p>Mae\'s recipe.</p>', date: '2026-11-26T06:00:00Z', by: 'Stefan' },
    { type: 'experience', id: 'exp-1', text: null, date: null, by: null },
  ],
};
const old: Policy = { ...fueling, id: 'p-old', title: 'Old way', status: 'deprecated', action_count: 0 };

const show = async (policies: Policy[] = [fueling, wine, old]) => {
  vi.mocked(apiService.get).mockResolvedValue({ policies });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><Policies /></MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Fueling a vehicle' });
};
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Policies page', () => {
  beforeEach(() => {
    role = 'admin';
    vi.mocked(apiService.get).mockReset();
    vi.mocked(apiService.post).mockReset().mockResolvedValue({});
    vi.mocked(apiService.put).mockReset().mockResolvedValue({});
  });

  it('lists titles, and shows text, reasoning and sources on opening one', async () => {
    await show();
    expect(screen.queryByText('Purchase a full tank.')).toBeNull();
    click('Fueling a vehicle');
    expect(screen.getByText('Purchase a full tank.')).toBeInTheDocument();
    expect(screen.getByText('To track km/l.')).toBeInTheDocument();
    expect(screen.getByText('Used by 189 actions')).toBeInTheDocument();
    click('Making bignay wine');
    expect(screen.getByRole('link', { name: /Observation · Stefan · Nov 26, 2026/ })).toHaveAttribute('href', '/observations/edit/obs-1');
    expect(screen.getByText('Mae\'s recipe.')).toBeInTheDocument();
    expect(screen.getByText('Experience you cannot see')).toBeInTheDocument();
  });

  it('searches titles and text, and keeps retired ones hidden until asked', async () => {
    await show();
    expect(screen.queryByRole('button', { name: 'Old way' })).toBeNull();
    click('Show retired (1)');
    expect(screen.getByRole('button', { name: 'Old way' })).toBeInTheDocument();
    type('Search policies', 'ripe');
    expect(screen.getByRole('button', { name: 'Making bignay wine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fueling a vehicle' })).toBeNull();
  });

  it('shows no way to change anything to a contributor', async () => {
    role = 'contributor';
    await show();
    click('Making bignay wine');
    expect(screen.queryByRole('button', { name: /New policy|Edit|Retire|Remove/ })).toBeNull();
  });

  it('creates a policy', async () => {
    await show();
    click('New policy');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    type('Title', 'Grease bearings');
    type('Policy', 'Grease them monthly.');
    click('Save');
    await waitFor(() => expect(apiService.post).toHaveBeenCalledWith('/policies', {
      title: 'Grease bearings', description_text: 'Grease them monthly.', reasoning: '',
    }));
  });

  it('saves a change of reasoning alone without asking', async () => {
    await show();
    click('Fueling a vehicle');
    click('Edit');
    type('Reasoning (optional)', 'To find vehicle trouble.');
    click('Save');
    await waitFor(() => expect(apiService.put).toHaveBeenCalledWith('/policies/p-fuel', {
      title: 'Fueling a vehicle', description_text: 'Purchase a full tank.', reasoning: 'To find vehicle trouble.',
    }));
    expect(apiService.post).not.toHaveBeenCalled();
  });

  it('asks about changed text on a used policy, and can keep it as a wording fix', async () => {
    await show();
    click('Fueling a vehicle');
    click('Edit');
    type('Policy', 'Buy a full tank.');
    click('Save');
    expect(screen.getByText('This policy is used by 189 actions. Is this a wording fix?')).toBeInTheDocument();
    expect(apiService.put).not.toHaveBeenCalled();
    click('Save as wording fix');
    await waitFor(() => expect(apiService.put).toHaveBeenCalledWith('/policies/p-fuel', expect.objectContaining({ description_text: 'Buy a full tank.' })));
    expect(apiService.post).not.toHaveBeenCalled();
  });

  it('can save a change of practice as a new policy and retire the old one', async () => {
    await show();
    click('Fueling a vehicle');
    click('Edit');
    type('Policy', 'Record every fill.');
    click('Save');
    click('Save as new policy and retire this one');
    await waitFor(() => expect(apiService.put).toHaveBeenCalledWith('/policies/p-fuel', { status: 'deprecated' }));
    expect(apiService.post).toHaveBeenCalledWith('/policies', {
      title: 'Fueling a vehicle', description_text: 'Record every fill.', reasoning: 'To track km/l.',
    });
  });

  it('retires only after confirming, and removes only the source chosen', async () => {
    await show();
    click('Making bignay wine');
    click('Retire');
    expect(apiService.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(apiService.put).toHaveBeenCalledWith('/policies/p-wine', { status: 'deprecated' }));
    click('Remove this observation');
    click('Remove');
    await waitFor(() => expect(apiService.put).toHaveBeenCalledWith('/policies/p-wine', { observation_ids: [], experience_ids: ['exp-1'] }));
  });
});
