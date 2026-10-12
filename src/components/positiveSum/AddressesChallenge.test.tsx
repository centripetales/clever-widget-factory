import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddressesChallenge } from './AddressesChallenge';
import type { Challenge, MyGoal } from '@/types/positiveSum';

const mutate = vi.fn();
vi.mock('@/hooks/positiveSum/usePositiveSum', () => ({ useLinkChallenge: () => ({ mutate, isPending: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const challenge = (id: string, text: string) => ({ id, text }) as Challenge;
const goal = (addresses: MyGoal['addresses']) => ({ id: 'store', organization_id: 'ps', addresses }) as MyGoal;
const SELL = challenge('sell', 'No place to sell our goods');
const THEFT = challenge('theft', 'Coconuts are being stolen');

describe('AddressesChallenge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the challenges it is linked to and offers the rest', () => {
    render(<AddressesChallenge goal={goal([{ id: 'sell', text: SELL.text, linked_by: 'stefan' }])} challenges={[SELL, THEFT]} />);

    expect(screen.getByText('Addresses')).toBeInTheDocument();
    expect(screen.getByText('No place to sell our goods')).toBeInTheDocument();
    expect(screen.getByLabelText('Where does this help?')).toBeInTheDocument();
  });

  it('removes a link', () => {
    render(<AddressesChallenge goal={goal([{ id: 'sell', text: SELL.text, linked_by: 'stefan' }])} challenges={[SELL]} />);

    fireEvent.click(screen.getByLabelText('Remove the link to "No place to sell our goods"'));
    expect(mutate).toHaveBeenCalledWith(
      { organizationId: 'ps', goalId: 'store', challengeId: 'sell', remove: true }, expect.anything());
    // Every challenge is already linked, so there is nothing left to pick.
    expect(screen.queryByLabelText('Where does this help?')).not.toBeInTheDocument();
  });

  it('shows nothing when there are no challenges at all', () => {
    const { container } = render(<AddressesChallenge goal={goal([])} challenges={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
