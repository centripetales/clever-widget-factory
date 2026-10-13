import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TakePart } from './TakePart';

const mutate = vi.fn();
vi.mock('@/hooks/positiveSum/usePositiveSum', () => ({ useTakePart: () => ({ mutate, isPending: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

describe('TakePart', () => {
  beforeEach(() => vi.clearAllMocks());

  it('signs the person up with what they wrote', () => {
    render(<TakePart goalId="store" joined={false} />);

    fireEvent.click(screen.getByText('Join'));
    fireEvent.change(screen.getByLabelText("Your ideas, and how you'd like to be involved"), {
      target: { value: 'I can lend a shelf and mind the store on Saturdays.' },
    });
    fireEvent.click(screen.getByText('Join'));

    expect(mutate).toHaveBeenCalledWith(
      { goalId: 'store', comment: 'I can lend a shelf and mind the store on Saturdays.' }, expect.anything());
  });

  it('lets someone sign up without a comment, but not add an empty one later', () => {
    const { unmount } = render(<TakePart goalId="store" joined={false} />);
    fireEvent.click(screen.getByText('Join'));
    expect(screen.getByText('Join')).toBeEnabled();
    unmount();

    render(<TakePart goalId="store" joined />);
    fireEvent.click(screen.getByText('Add a comment'));
    expect(screen.getByText('Add comment')).toBeDisabled();
  });
});
