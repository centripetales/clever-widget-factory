import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ChallengesSection } from './ChallengesSection';
import type { Challenge, MyGoal } from '@/types/positiveSum';

const createChallenge = { mutate: vi.fn(), isPending: false };
const vote = { mutate: vi.fn(), isPending: false };
const createGoal = { mutate: vi.fn(), isPending: false };
const remove = { mutate: vi.fn() };
const editChallenge = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
vi.mock('@/hooks/positiveSum/usePositiveSum', () => ({
  useCreateChallenge: () => createChallenge,
  useVoteForChallenge: () => vote,
  useCreateGoal: () => createGoal,
  useDeleteGoal: () => remove,
  useEditChallenge: () => editChallenge,
  useTakePart: () => ({ mutate: vi.fn(), isPending: false }),
  useLinkChallenge: () => ({ mutate: vi.fn(), isPending: false }),
  useAddReward: () => ({ mutate: vi.fn(), isPending: false }),
  useEditReward: () => ({ mutate: vi.fn(), isPending: false }),
  useEditSharedObservation: () => ({ mutate: vi.fn(), isPending: false }),
  useAcceptReward: () => ({ mutate: vi.fn(), isPending: false }),
  useCloseReward: () => ({ mutate: vi.fn(), isPending: false }),
}));
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/hooks/useCognitoAuth', () => ({ useAuth: () => ({ user: { userId: 'stefan' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useImageUpload', () => ({ useImageUpload: () => ({ uploadSingleImage: vi.fn(), isUploading: false }) }));

const challenge = (overrides: Partial<Challenge>): Challenge => ({
  id: 'theft', organization_id: 'ps', text: 'Coconuts are being stolen', owner: 'may', owner_name: 'May',
  created_at: '2026-10-11T00:00:00Z', votes: 2, voted_by_me: false, collaborations: [], ...overrides,
});

describe('ChallengesSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a challenge in the person\'s words', () => {
    render(<ChallengesSection organizationId="ps" challenges={[]} />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Describe where we could improve"), { target: { value: ' Copra buyers are unreliable ' } });
    fireEvent.click(screen.getByText('Add'));

    expect(createChallenge.mutate).toHaveBeenCalledWith(
      { organizationId: 'ps', challenge: 'Copra buyers are unreliable' }, expect.anything());
  });

  it('shows votes and lets a person vote once', () => {
    render(<ChallengesSection organizationId="ps" challenges={[challenge({}), challenge({ id: 'buyers', text: 'Copra buyers are unreliable', votes: 1, voted_by_me: true })]} />);

    const open = screen.getByRole('button', { name: 'This affects me too, 2 people share it' });
    const voted = screen.getByRole('button', { name: 'This affects you too, 1 person shares it' });
    expect(open).toHaveTextContent('2');
    fireEvent.click(open);
    expect(vote.mutate).toHaveBeenCalledWith('theft', expect.anything());
    expect(voted).toBeDisabled();
    expect(voted.className).toContain('bg-amber-100');
    expect(open.className).not.toContain('bg-amber-100');
  });

  it('proposes a collaboration for a challenge and lists the ones proposed', () => {
    const proposed = { id: 'watch', title: 'Neighbors report strangers', status: 'external_proposal', created_by: 'may', created_by_name: 'May', participants: ['lester'] };
    render(<ChallengesSection organizationId="ps" challenges={[challenge({ collaborations: [proposed] })]} />);

    // One row per proposed collaboration: its text, who is in, and the button to join.
    const row = screen.getByText('Neighbors report strangers').closest('.justify-between') as HTMLElement;
    expect(within(row).getByText('1 joined')).toBeInTheDocument();
    expect(within(row).getByText('Join')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Propose a collaboration'));
    fireEvent.change(screen.getByLabelText('What could we do together about this?'), { target: { value: 'Share a night watch' } });
    fireEvent.click(screen.getByText('Propose'));

    expect(createGoal.mutate).toHaveBeenCalledWith(
      { organization_id: 'ps', desired_state: 'Share a night watch', challenge_id: 'theft' }, expect.anything());
  });

  it('lets only its owner delete an entry, while nobody else has raised a hand for it, after confirming', () => {
    render(<ChallengesSection organizationId="ps" challenges={[
      challenge({ id: 'mine', text: 'My new challenge', owner: 'stefan', votes: 0 }),
      challenge({ id: 'own-hand', text: 'Only my hand is up', owner: 'stefan', votes: 1, voters: [{ id: 'stefan', name: 'Stefan' }] }),
      challenge({ id: 'voted', text: 'My voted challenge', owner: 'stefan', votes: 2, voters: [{ id: 'stefan', name: 'Stefan' }, { id: 'may', name: 'May' }] }),
      challenge({ id: 'theirs', votes: 0 }),
    ]} />);

    const buttons = screen.getAllByLabelText('Delete this');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(remove.mutate).not.toHaveBeenCalled(); // asks first
    fireEvent.click(screen.getByText('Delete'));
    expect(remove.mutate).toHaveBeenCalledWith('own-hand', expect.anything());
  });

  it('offers the org\'s people as assignee while editing, and shows the assignee beside the title otherwise', () => {
    const members = [{ id: 'stefan', name: 'Stefan' }, { id: 'may', name: 'May' }];
    render(<ChallengesSection organizationId="ps" members={members}
      challenges={[challenge({ id: 'mine', text: 'No place to sell our goods', owner: 'stefan', owner_name: 'Stefan' })]} />);

    const title = screen.getByText('No place to sell our goods');
    expect(within(title.parentElement!).getByText('Stefan')).toBeInTheDocument();
    expect(screen.queryByLabelText('Assigned to')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit this' }));
    expect(screen.getByLabelText('Assigned to')).toHaveTextContent('Stefan');
  });

  it('lets a challenge be assigned to someone who voted for it, even with no org people listed', () => {
    render(<ChallengesSection organizationId="ps" members={[]} challenges={[challenge({
      id: 'mine', owner: 'stefan', owner_name: 'Stefan', votes: 1,
      voters: [{ id: 'lester', name: 'Lester' }],
    })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit this' }));
    expect(screen.getByLabelText('Assigned to')).toBeInTheDocument();
  });

  it('lets only the owner reword a challenge', () => {
    render(<ChallengesSection organizationId="ps" challenges={[
      challenge({ id: 'mine', text: 'No place to sell our goods', owner: 'stefan', votes: 3 }),
      challenge({ id: 'theirs' }),
    ]} />);

    const edits = screen.getAllByRole('button', { name: 'Edit this' });
    expect(edits).toHaveLength(1);
    fireEvent.click(edits[0]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit this' }), { target: { value: 'No shared place to sell our goods ' } });
    fireEvent.click(screen.getByText('Save'));

    // Unless changed, the assignee stays who it was.
    expect(editChallenge.mutate).toHaveBeenCalledWith(
      { organizationId: 'ps', id: 'mine', text: 'No shared place to sell our goods', assignedTo: 'stefan' }, expect.anything());
  });

  describe('my own proposed collaborations', () => {
    const proposed = { id: 'watch', title: 'Neighbors report strangers', status: 'external_proposal', created_by: 'stefan', created_by_name: 'Stefan', participants: ['may'] };
    const goal = (overrides: Partial<MyGoal>) => ({
      id: 'watch', organization_id: 'ps', title: 'Neighbors report strangers', desired_state: 'Neighbors report strangers',
      status: 'external_proposal', created_by: 'stefan', implementors: ['stefan', 'may'], participants: ['may'], options: [],
      taking_part: [{ id: 'may', name: 'May', comments: ['I can take Tuesdays.'] }],
      addresses: [{ id: 'theft', text: 'Coconuts are being stolen', linked_by: 'stefan' }], ...overrides,
    }) as MyGoal;

    it('shows the author who is contributing and a delete on its row, without repeating which challenge it addresses', () => {
      render(<ChallengesSection organizationId="ps" challenges={[challenge({ collaborations: [proposed] })]} goals={[goal({})]} />);

      expect(screen.getByText('Joined')).toBeInTheDocument();
      expect(screen.getByText('I can take Tuesdays.')).toBeInTheDocument();
      expect(screen.queryByText('Addresses')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Where does this help?')).not.toBeInTheDocument();
      expect(screen.queryByText('Your proposed collaborations not placed under anything above')).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Delete this proposed collaboration'));
      fireEvent.click(screen.getByText('Delete'));
      expect(remove.mutate).toHaveBeenCalledWith('watch', expect.anything());
    });

    it('lets the author reword their proposal', async () => {
      render(<ChallengesSection organizationId="ps" challenges={[challenge({ collaborations: [proposed] })]} goals={[goal({})]} />);

      fireEvent.click(screen.getByRole('button', { name: 'Edit this proposed collaboration' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit this proposed collaboration' }), { target: { value: 'Neighbors report strangers to the barangay ' } });
      fireEvent.click(screen.getByText('Save'));

      expect(editChallenge.mutateAsync).toHaveBeenCalledWith(
        { organizationId: 'ps', id: 'watch', text: 'Neighbors report strangers to the barangay' });
      await waitFor(() => expect(screen.queryByText('Save')).not.toBeInTheDocument());
    });

    it('opens the proposal\'s action when it is clicked', () => {
      render(<ChallengesSection organizationId="ps" challenges={[challenge({ collaborations: [proposed] })]} goals={[]} />);

      fireEvent.click(screen.getByText('Neighbors report strangers'));
      expect(navigate).toHaveBeenCalledWith('/actions/watch');
    });

    it('keeps a proposal joinable once someone has joined, but no longer deletable', () => {
      const started = { ...proposed, status: 'not_started' };
      render(<ChallengesSection organizationId="ps" challenges={[challenge({ collaborations: [started] })]} goals={[goal({ status: 'not_started' })]} />);

      expect(screen.getByText('Join')).toBeInTheDocument();
      expect(screen.getByLabelText('Edit this proposed collaboration')).toBeInTheDocument();
      expect(screen.queryByLabelText('Delete this proposed collaboration')).not.toBeInTheDocument();
    });

    it('still renders a list saved in the browser before proposals became actions', () => {
      const saved = { id: 'watch', desired_state: 'Neighbors report strangers', status: 'external_proposal', created_by: 'may', created_by_name: 'May', implementors: ['lester'] };
      render(<ChallengesSection organizationId="ps" challenges={[challenge({ collaborations: [saved as never] })]} goals={[]} />);

      expect(screen.getByText('Neighbors report strangers')).toBeInTheDocument();
      expect(screen.getByText('Join')).toBeInTheDocument();
    });

    it('shows someone else\'s proposal without the author\'s extras', () => {
      render(<ChallengesSection organizationId="ps" challenges={[challenge({ collaborations: [{ ...proposed, created_by: 'may' }] })]} goals={[]} />);

      expect(screen.getByText('Neighbors report strangers')).toBeInTheDocument();
      expect(screen.getByText('Join')).toBeInTheDocument();
      expect(screen.queryByText('Joined')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Delete this proposed collaboration')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Edit this proposed collaboration')).not.toBeInTheDocument();
    });

    it('lists my proposals that are not linked to any challenge, so they can be linked', () => {
      render(<ChallengesSection organizationId="ps" challenges={[challenge({})]} goals={[goal({ id: 'ponds', title: 'Clay lined ponds', desired_state: 'Clay lined ponds', addresses: [], taking_part: [] })]} />);

      expect(screen.getByText('Your proposed collaborations not placed under anything above')).toBeInTheDocument();
      expect(screen.getByText('Clay lined ponds')).toBeInTheDocument();
      expect(screen.getByLabelText('Where does this help?')).toBeInTheDocument();
    });
  });
});
