import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RewardsSection } from '../RewardsSection';
import type { ActionRewards } from '@/types/rewards';

const SG = 'stargazer';
const LESTER = 'lester';

// 6 banana suckers from Lester's parents for ₱200 (docs/design/POSITIVE_SUM.md §2.6)
const rewards: ActionRewards = {
  claims: [{
    name: 'Paid for suckers', from_org_id: SG, from_name: 'Stargazer Farm', to_org_id: LESTER, to_name: "Lester's parents",
    php: 200, hours: null, cost_basis_method: 'purchase_price', claim: '₱200 for 6 banana suckers.', source_state_ids: ['description'],
  }],
  next_best_options: [
    {
      name: 'Asking around', for_org_id: SG, for_name: 'Stargazer Farm', kind: 'cost_another_way', php: null, hours: 2,
      replaces: ['Paid for suckers'], claim: 'About 2 hours of asking around.', source_state_ids: ['next-best'], stated_by: ['Stefan'],
    },
    {
      name: 'Left in the clump', for_org_id: LESTER, for_name: "Lester's parents", kind: 'had_otherwise', php: 10, hours: null,
      replaces: ['Paid for suckers'], claim: 'Worth about 10 left alone.', source_state_ids: [], stated_by: ['Stefan'],
    },
  ],
  org_names: { [SG]: 'Stargazer Farm', [LESTER]: "Lester's parents" },
  context_state_ids: [], created_at: '2026-10-10T00:00:00Z', status: 'SUCCESS', error: null,
};

const createState = vi.fn().mockResolvedValue({});
const rebuild = { mutate: vi.fn() };
const saveOpportunityCosts = { mutate: vi.fn() };

vi.mock('@/hooks/useActionReward', () => ({
  useActionReward: () => ({ data: rewards, isLoading: false, rebuild, saveOpportunityCosts, isBuilding: false }),
}));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => ({ organization: { id: 'stargazer' } }) }));
const deleteState = vi.fn().mockResolvedValue({});
const observations = [
  { id: 'description', observation_text: 'We purchased 10 suckers.', captured_by_name: 'Stefan', captured_at: '2026-10-10T00:00:00Z' },
  { id: 'adjustment', observation_text: 'Adjustment to "Paid for suckers": the amount is ₱250.', captured_by_name: 'Stefan', captured_at: '2026-10-10T00:00:00Z' },
  { id: 'next-best', observation_text: 'Next best option for Stargazer Farm: Asking around.', captured_by_name: 'Stefan', captured_at: '2026-10-10T00:00:00Z' },
];
vi.mock('@/hooks/useStates', () => ({
  useStateMutations: () => ({ createState, deleteState }),
  useStates: (orgId: string) => ({ data: orgId ? observations : [] }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

describe('RewardsSection', () => {
  it('shows each party\'s next-best option and its advantage', () => {
    render(<RewardsSection actionId="action-1" justCreated />);

    expect(screen.getByText('Next best: Asking around')).toBeInTheDocument();
    expect(screen.getByText('Next best: Left in the clump')).toBeInTheDocument();
    // People and organizations are chips, not plain text
    expect(screen.getAllByText('Documented by')).toHaveLength(2);
    expect(screen.getAllByText('Stefan', { selector: 'span.rounded-full' })).toHaveLength(2);

    // Expected advantage: one row per party, pesos and time in their own columns
    const table = screen.getByText('Advantage').parentElement!;
    const texts = [...table.children].map(c => c.textContent);
    expect(texts).toEqual([
      '', 'Advantage', 'Time',
      'Stargazer Farm', '−₱200', '+2 hours',
      "Lester's parents", '+₱190', '—',
      'Value created', '−₱10', '+2 hours',
    ]);
  });

  it('saves a documented next best as the person\'s observation, then rebuilds', async () => {
    render(<RewardsSection actionId="action-1" justCreated />);

    fireEvent.click(screen.getAllByText('Add another next best')[1]);
    const what = screen.getByPlaceholderText("What would Lester's parents have had otherwise?");
    fireEvent.change(what, { target: { value: 'Fed to the chickens' } });
    fireEvent.change(screen.getByPlaceholderText('Total ₱, optional'), { target: { value: '15' } });
    fireEvent.click(screen.getByText('Save and rebuild'));

    await waitFor(() => expect(screen.queryByText('Save and rebuild')).not.toBeInTheDocument());
    expect(createState).toHaveBeenCalledWith({
      state_text: "Next best option for Lester's parents: Fed to the chickens. That would have been worth ₱15.", photos: [],
      links: [{ entity_type: 'action', entity_id: 'action-1' }],
    });
  });

  it('substitutes the opportunity cost the viewer enters for a party\'s time', () => {
    render(<RewardsSection actionId="action-1" justCreated />);

    // A total for the time, not a rate: ₱300 stands in for the 2 hours.
    fireEvent.change(screen.getByLabelText('Opportunity cost of Stargazer Farm time in pesos'), { target: { value: '300' } });
    expect(screen.queryByLabelText("Opportunity cost of Lester's parents time in pesos")).not.toBeInTheDocument();

    // The working shows in the Advantage column, and the total takes the converted figure.
    const texts = [...screen.getByText('Advantage').parentElement!.children].map(c => c.textContent);
    expect(texts.slice(3)).toEqual([
      'Stargazer Farm', '−₱200 + ₱300', '+2 hours',
      "Lester's parents", '+₱190', '—',
      'Value created', '+₱290', '—',
    ]);
    expect(screen.getByText('+₱100')).toBeInTheDocument();
    expect(screen.getByText('+₱290')).toHaveClass('text-green-700');

    // Leaving the field saves what was entered
    fireEvent.blur(screen.getByLabelText('Opportunity cost of Stargazer Farm time in pesos'));
    expect(saveOpportunityCosts.mutate).toHaveBeenCalledWith({ stargazer: 300 }, expect.anything());
  });

  it('starts an adjustment from the claim\'s current amount', () => {
    render(<RewardsSection actionId="action-1" justCreated />);

    fireEvent.click(screen.getByText('Adjust'));
    expect(screen.getByPlaceholderText('₱, optional')).toHaveValue(200);
    expect(screen.getByPlaceholderText('Hours, optional')).toHaveValue(null);
    expect(screen.getByText('Save and rebuild')).toBeDisabled();
  });

  it('has no observation input on an ordinary action', () => {
    render(<RewardsSection actionId="action-1" justCreated />);
    expect(screen.queryByText('Add and rebuild')).not.toBeInTheDocument();
  });

  it('lets what was added on a transaction be deleted, but not the transaction\'s description', async () => {
    render(
      <RewardsSection
        actionId="action-1"
        alsoLinkTo={{ entity_type: 'financial_record', entity_id: 'record-1' }}
        descriptionStateId="description"
        justCreated
      />
    );

    expect(screen.queryByText('We purchased 10 suckers.')).not.toBeInTheDocument();
    // The next best carries the observation it came from; the adjustment led to no claim, so it is listed at the end.
    expect(screen.getByText('Next best option for Stargazer Farm: Asking around.')).toBeInTheDocument();
    expect(screen.getByText('Also added here')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Delete this observation')).toHaveLength(2);

    fireEvent.click(screen.getAllByLabelText('Delete this observation')[0]);
    fireEvent.click(screen.getByText('Delete and rebuild'));

    await waitFor(() => expect(rebuild.mutate).toHaveBeenCalled());
    expect(deleteState).toHaveBeenCalledWith('next-best');
  });

  it('links an added observation to the action and the transaction, then rebuilds', async () => {
    render(<RewardsSection actionId="action-1" alsoLinkTo={{ entity_type: 'financial_record', entity_id: 'record-1' }} justCreated />);

    const input = screen.getByPlaceholderText(/what would you/);
    fireEvent.change(input, { target: { value: 'It would have taken 2 hours.' } });
    fireEvent.click(screen.getByText('Add and rebuild'));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(rebuild.mutate).toHaveBeenCalled();
    expect(createState).toHaveBeenCalledWith({
      state_text: 'It would have taken 2 hours.', photos: [],
      links: [{ entity_type: 'action', entity_id: 'action-1' }, { entity_type: 'financial_record', entity_id: 'record-1' }],
    });
  });
});
