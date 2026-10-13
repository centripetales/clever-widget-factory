import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddReward, RewardOffer } from './RewardOffer';
import type { OfferedReward } from '@/types/positiveSum';

const accept = { mutate: vi.fn(), isPending: false };
const close = { mutate: vi.fn(), isPending: false };
const add = { mutate: vi.fn(), isPending: false };
const createGoal = { mutateAsync: vi.fn(), isPending: false };
const change = { mutate: vi.fn(), isPending: false };
vi.mock('@/hooks/positiveSum/usePositiveSum', () => ({
  useAcceptReward: () => accept, useCloseReward: () => close, useAddReward: () => add, useCreateGoal: () => createGoal, useEditReward: () => change,
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const reward = (overrides: Partial<OfferedReward>): OfferedReward => ({
  id: 'r1', php: 5, cap_php_per_person: 500, payer_name: 'Stargazer Farm', owner: 'stefan', closed: false,
  terms: 'Stargazer Farm pays ₱5 for each photo you share here with a description, up to ₱500 per person.',
  accepted_by_me: false, tally: [], ...overrides,
});

describe('RewardOffer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows what is paid and by whom, and the terms before a person agrees', () => {
    render(<RewardOffer reward={reward({})} organizationId="ps" userId="may" />);

    expect(screen.getByText('₱5 for each photo with a description')).toBeInTheDocument();
    expect(screen.getByText(/up to ₱500 per person/)).toBeInTheDocument();
    expect(screen.getByText(/paid by Stargazer Farm/)).toBeInTheDocument();
    expect(screen.queryByText(/Stargazer Farm pays ₱5 for each photo you share/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Earn this'));
    expect(screen.getByText(/Stargazer Farm pays ₱5 for each photo you share/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('I agree'));
    expect(accept.mutate).toHaveBeenCalledWith({ organizationId: 'ps', rewardId: 'r1' }, expect.anything());
  });

  it('shows a person what they have earned, and everyone the tally', () => {
    const tally = [{ id: 'may', name: 'Mae', count: 7, php: 35 }, { id: 'lester', name: 'Lester', count: 2, php: 10 }];
    render(<RewardOffer reward={reward({ accepted_by_me: true, tally })} organizationId="ps" userId="may" />);

    expect(screen.getByText(/You: 7 shared/)).toBeInTheDocument();
    expect(screen.queryByText('Earn this')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/2 people · 9 shared · ₱45/));
    expect(screen.getByText('Lester')).toBeInTheDocument();
    expect(screen.getByText('₱10')).toBeInTheDocument();
  });

  it('lets only its owner close it, and offers nothing once closed', () => {
    const { rerender } = render(<RewardOffer reward={reward({})} organizationId="ps" userId="may" />);
    expect(screen.queryByText('Close')).not.toBeInTheDocument();

    rerender(<RewardOffer reward={reward({})} organizationId="ps" userId="stefan" />);
    fireEvent.click(screen.getByText('Close'));
    expect(close.mutate).toHaveBeenCalledWith({ organizationId: 'ps', rewardId: 'r1' }, expect.anything());

    rerender(<RewardOffer reward={reward({ closed: true })} organizationId="ps" userId="may" />);
    expect(screen.getByText(/closed/)).toBeInTheDocument();
    expect(screen.queryByText('Earn this')).not.toBeInTheDocument();
  });
  it('for an offer that says what it is looking for: shows the ask, a way to share, and the last reading', () => {
    const read = reward({
      ask: 'Organic and non-organic practices', action_id: 'practices', accepted_by_me: true, budget_php: 5000, spent_php: 45,
      my_latest: { shows: 'Compost pit', counts: true, php: 5, feedback: 'Pest control is not covered yet.' },
    });
    render(<RewardOffer reward={read} organizationId="ps" userId="may" />);

    expect(screen.getByText(/Up to ₱5 for each observation/)).toBeInTheDocument();
    expect(screen.getByText(/₱45 of ₱5,000 used/)).toBeInTheDocument();
    expect(screen.getByText('How it is valued: Organic and non-organic practices')).toBeInTheDocument();
    expect(screen.getByText(/Your last one: Compost pit · counted, ₱5 · Pest control is not covered yet\./)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Share an observation'));
    expect(navigate).toHaveBeenCalledWith('/combined-assets/actions/practices/observation');
  });
  it('lets its owner change an offer while nothing has been read against it', () => {
    const mine = reward({ ask: 'Credit ₱20 for an activity', php: 10, cap_php_per_person: 400, owner: 'may', editable: true });
    const { rerender } = render(<RewardOffer reward={{ ...mine, editable: false }} organizationId="ps" userId="may" />);
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();

    rerender(<RewardOffer reward={mine} organizationId="ps" userId="may" />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('Pesos for each observation'), { target: { value: '20' } });
    fireEvent.click(screen.getByText('Save'));

    expect(change.mutate).toHaveBeenCalledWith(
      { organizationId: 'ps', rewardId: 'r1', php: 20, capPerPerson: 400, ask: 'Credit ₱20 for an activity', budget: null }, expect.anything());
  });
});

describe('AddReward', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts at ₱5 up to ₱500 per person and saves what the author sets', () => {
    render(<AddReward organizationId="ps" actionId="photos" />);
    fireEvent.click(screen.getByText('Add a reward'));

    expect(screen.getByLabelText('Pesos for each observation')).toHaveValue(5);
    expect(screen.getByLabelText('Most one person can earn, in pesos')).toHaveValue(500);
    fireEvent.change(screen.getByLabelText('Pesos for each observation'), { target: { value: '20' } });
    fireEvent.click(screen.getByText('Add reward'));

    expect(add.mutate).toHaveBeenCalledWith({ organizationId: 'ps', actionId: 'photos', php: 20, capPerPerson: 500 }, expect.anything());
  });

  it('refuses a cap smaller than one payment', () => {
    render(<AddReward organizationId="ps" actionId="photos" />);
    fireEvent.click(screen.getByText('Add a reward'));
    fireEvent.change(screen.getByLabelText('Most one person can earn, in pesos'), { target: { value: '3' } });
    expect(screen.getByText('Add reward')).toBeDisabled();
  });

  it('makes an offer from scratch: what is wanted is saved first, then the reward on it', async () => {
    createGoal.mutateAsync.mockResolvedValue({ id: 'new-action' });
    render(<AddReward organizationId="ps" />);
    fireEvent.click(screen.getByText('Make an offer'));
    expect(screen.getByText('Make offer')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('What do you want?'), { target: { value: ' Photos of how you farm ' } });
    fireEvent.click(screen.getByText('Make offer'));

    await vi.waitFor(() => expect(add.mutate).toHaveBeenCalled());
    expect(createGoal.mutateAsync).toHaveBeenCalledWith({ organization_id: 'ps', desired_state: 'Photos of how you farm' });
    expect(add.mutate).toHaveBeenCalledWith({ organizationId: 'ps', actionId: 'new-action', php: 5, capPerPerson: 500 }, expect.anything());
  });
});
