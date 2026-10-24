import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SharedObservations } from './SharedObservations';
import type { SharedObservation } from '@/types/positiveSum';

const edit = { mutate: vi.fn(), isPending: false };
vi.mock('@/hooks/positiveSum/usePositiveSum', () => ({ useEditSharedObservation: () => edit }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
const { flyCoin } = vi.hoisted(() => ({ flyCoin: vi.fn() }));
vi.mock('@/lib/coinFly', () => ({ flyCoin }));

const observation = (overrides: Partial<SharedObservation>): SharedObservation => ({
  id: 's1', person: 'may', name: 'May', mine: true, text: 'Compost pit', photos: [],
  created_at: '2026-10-12T01:00:00Z', reading: 'read', php: 3, was_php: null, feedback: 'Say what goes into it.', ...overrides,
});

describe('SharedObservations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows what a person wrote, what it was credited and why', () => {
    render(<SharedObservations observations={[observation({})]} payerName="Stargazer Farm" />);
    expect(screen.getByText('Compost pit')).toBeInTheDocument();
    expect(screen.getByText('₱3')).toBeInTheDocument();
    expect(screen.getByText('Say what goes into it.')).toBeInTheDocument();
  });

  it('sends a coin to the balance when a reading arrives while the person watches, and when they press the amount', () => {
    const { rerender } = render(<SharedObservations observations={[observation({ reading: 'read' })]} payerName="Stargazer Farm" />);
    expect(flyCoin).not.toHaveBeenCalled(); // already credited when the page opened

    rerender(<SharedObservations observations={[observation({ reading: 'waiting', php: null })]} payerName="Stargazer Farm" />);
    rerender(<SharedObservations observations={[observation({ reading: 'read', php: 5 })]} payerName="Stargazer Farm" />);
    expect(flyCoin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('₱5'));
    expect(flyCoin).toHaveBeenCalledTimes(2);
  });

  it('sends no coin for someone else\'s credit or for nothing credited', () => {
    const { rerender } = render(<SharedObservations observations={[observation({ reading: 'waiting', php: null })]} payerName="Stargazer Farm" />);
    rerender(<SharedObservations observations={[observation({ reading: 'read', php: 0 })]} payerName="Stargazer Farm" />);
    rerender(<SharedObservations observations={[observation({ reading: 'waiting', php: null, mine: false })]} payerName="Stargazer Farm" />);
    rerender(<SharedObservations observations={[observation({ reading: 'read', php: 5, mine: false })]} payerName="Stargazer Farm" />);
    expect(flyCoin).not.toHaveBeenCalled();
  });

  it('links each earlier observation the reading compared it with, opening the list to reach one further down', () => {
    const compared = { id: 's9', name: 'Lester', created_at: '2026-10-10T01:00:00Z', text: 'Seed trays on the coconut platform', adds: 'sprouting overnight', repeats: false };
    const list = [
      observation({ id: 's1', compared_with: [compared, { ...compared, id: 'gone', text: 'Not in this list', repeats: true }] }),
      observation({ id: 's2' }), observation({ id: 's3' }), observation({ id: 's9', text: 'Trays watered', name: 'Lester', mine: false }),
    ];
    render(<SharedObservations observations={list} payerName="Stargazer Farm" />);
    expect(screen.queryByText('Trays watered')).not.toBeInTheDocument(); // fourth: hidden at first
    const link = screen.getByRole('button', { name: /10\/2026 · Lester: Seed trays on the coconut platform/ });
    expect(link).toHaveAttribute('title', 'Adds: sprouting overnight');
    expect(screen.getByText('Not in this list').closest('button')).toBeNull(); // not in the list: no link
    fireEvent.click(link);
    expect(screen.getByText('Trays watered')).toBeInTheDocument();
  });

  it('opens a person\'s own words for editing when they select them', () => {
    render(<SharedObservations observations={[observation({})]} payerName="Stargazer Farm" />);
    fireEvent.click(screen.getByLabelText('Edit what you wrote'));
    expect(screen.getByLabelText('What you wrote')).toHaveValue('Compost pit');
    expect(screen.getByText('Save and read again')).toBeDisabled(); // nothing changed yet

    fireEvent.change(screen.getByLabelText('What you wrote'), { target: { value: 'Compost pit: rice hull and goat manure' } });
    fireEvent.click(screen.getByText('Save and read again'));
    expect(edit.mutate).toHaveBeenCalledWith({ id: 's1', text: 'Compost pit: rice hull and goat manure' }, expect.anything());
  });

  it('edits what was written on a photo, keeping the other photos as they are', () => {
    const photos = [{ url: 'a.jpg', description: 'Crimped cogon' }, { url: 'b.jpg', description: 'After rain' }];
    render(<SharedObservations observations={[observation({ text: '', photos })]} payerName="Stargazer Farm" />);
    fireEvent.click(screen.getByText('After rain'));
    fireEvent.change(screen.getByLabelText('What you wrote on the photo'), { target: { value: 'After two weeks of rain' } });
    fireEvent.click(screen.getByText('Save and read again'));
    expect(edit.mutate).toHaveBeenCalledWith(
      { id: 's1', photos: [photos[0], { url: 'b.jpg', description: 'After two weeks of rain' }] }, expect.anything());
  });

  it('lets a person reply to the feedback: the reply is added to what they wrote', () => {
    render(<SharedObservations observations={[observation({})]} payerName="Stargazer Farm" />);
    fireEvent.click(screen.getByText('Reply'));
    fireEvent.change(screen.getByLabelText('Your reply'), { target: { value: 'Rice hull and goat manure' } });
    fireEvent.click(screen.getByText('Save and read again'));
    expect(edit.mutate).toHaveBeenCalledWith({ id: 's1', text: 'Compost pit\n\nRice hull and goat manure' }, expect.anything());
  });

  it('shows one being read, and what an edit raised', () => {
    render(<SharedObservations payerName="Stargazer Farm" observations={[
      observation({ id: 'a', reading: 'waiting', php: null, feedback: '' }),
      observation({ id: 'b', text: 'Mulch', php: 5, was_php: 3 }),
    ]} />);
    expect(screen.getByText(/Reading…/)).toBeInTheDocument();
    expect(screen.getByText('₱3 →')).toBeInTheDocument();
    expect(screen.getByText('₱5')).toBeInTheDocument();
  });

  it('shows someone else\'s only with their name and no way to change it, and folds a long list', () => {
    const many = [1, 2, 3, 4].map(n => observation({ id: `s${n}`, text: `Note ${n}`, mine: false, name: 'Lester' }));
    render(<SharedObservations observations={many} payerName="Stargazer Farm" />);
    expect(screen.getAllByText('Lester')).toHaveLength(3);
    expect(screen.queryByText('Reply')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Edit what you wrote')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show all 4'));
    expect(screen.getByText('Note 4')).toBeInTheDocument();
  });
});

describe('SharedObservations, with a copy of the page data saved before photos were listed', () => {
  it('still shows the words written on the photos', () => {
    const saved = { ...observation({ text: '' }), photos: undefined, photo: 'a.jpg', captions: 'Crimped cogon' } as unknown as SharedObservation;
    render(<SharedObservations observations={[saved]} payerName="Stargazer Farm" />);
    expect(screen.getByText('Crimped cogon')).toBeInTheDocument();
  });
});
