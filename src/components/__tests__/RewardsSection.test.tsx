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
    php: 200, hours: null, cost_basis_method: 'purchase_price', claim: '₱200 for 6 banana suckers.', source_state_ids: [],
  }],
  next_best_options: [
    {
      name: 'Asking around', for_org_id: SG, for_name: 'Stargazer Farm', kind: 'cost_another_way', php: null, hours: 2,
      replaces: ['Paid for suckers'], claim: 'About 2 hours of asking around.', source_state_ids: [], stated_by: ['Stefan'],
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

vi.mock('@/hooks/useActionReward', () => ({
  useActionReward: () => ({ data: rewards, isLoading: false, rebuild, isBuilding: false }),
}));
vi.mock('@/hooks/useOrganization', () => ({ useOrganization: () => ({ organization: { id: 'stargazer' } }) }));
vi.mock('@/hooks/useStates', () => ({ useStateMutations: () => ({ createState }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

describe('RewardsSection', () => {
  it('shows each party\'s next-best option and its advantage', () => {
    render(<RewardsSection actionId="action-1" justCreated />);

    expect(screen.getByText('−₱200 · +2 hours')).toBeInTheDocument();
    expect(screen.getByText('+₱190')).toBeInTheDocument();
    expect(screen.getByText('Expected advantage')).toBeInTheDocument();
    expect(screen.getByText('Next best: Asking around')).toBeInTheDocument();
    expect(screen.getByText('Next best: Left in the clump')).toBeInTheDocument();
    expect(screen.getAllByText('Documented by Stefan')).toHaveLength(2);
    expect(screen.getByText('Total expected').nextSibling).toHaveTextContent('−₱10 · +2 hours');
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

  it('turns hours into pesos only at the rate the viewer enters', () => {
    render(<RewardsSection actionId="action-1" justCreated />);

    const control = screen.getByText("An hour of Stargazer Farm's time is worth ₱").parentElement!;
    fireEvent.change(control.querySelector('input')!, { target: { value: '150' } });
    expect(screen.getByText('+₱100')).toBeInTheDocument();
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
