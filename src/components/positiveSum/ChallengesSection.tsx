import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hand, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useCognitoAuth';
import {
  useCreateChallenge, useCreateGoal, useDeleteGoal, useEditChallenge, useVoteForChallenge,
} from '@/hooks/positiveSum/usePositiveSum';
import { errorMessage } from '@/lib/apiService';
import type { Challenge, MyGoal, ProposedCollaboration } from '@/types/positiveSum';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { TakePart } from './TakePart';
import { AddressesChallenge } from './AddressesChallenge';
import { AddReward, RewardOffer } from './RewardOffer';

function NameChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground break-words">
      {name}
    </span>
  );
}

// One proposed collaboration, as a row. Anyone can contribute to it. Its own
// author also sees who is contributing and what they said, and can delete it
// while nothing has been suggested for it. `mine` is the author's fuller copy, when the viewer is the author.
// A copy of the list saved in the browser before proposals became actions has
// the text as `desired_state` and no `participants`; read it without failing
// until the fresh list arrives.
function current(collaboration: ProposedCollaboration): ProposedCollaboration {
  const saved = collaboration as ProposedCollaboration & { desired_state?: string };
  return { ...collaboration, title: saved.title ?? saved.desired_state ?? '', participants: saved.participants ?? [] };
}

function CollaborationRow({ collaboration: given, mine, linkTo, userId, organizationId, onDelete, onEdit }: {
  organizationId: string;
  collaboration: ProposedCollaboration;
  mine?: MyGoal;
  onEdit: (id: string, text: string) => Promise<boolean>; // its author rewords it
  // The challenges it can be linked to. Only given for a proposal that is not
  // under a challenge yet; under one, saying what it addresses would repeat the card.
  linkTo?: Challenge[];
  userId?: string;
  onDelete: (id: string) => void;
}) {
  const collaboration = current(given);
  const navigate = useNavigate();
  // It can be joined and reworded until it is done; deleted only while nobody has joined.
  const open = collaboration.status !== 'completed';
  const untouched = collaboration.status === 'external_proposal';
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    if (await onEdit(collaboration.id, (draft ?? '').trim())) setDraft(null);
    setSaving(false);
  };

  if (draft !== null) {
    return (
      <div className="space-y-2">
        <Textarea rows={2} value={draft} onChange={e => setDraft(e.target.value)} aria-label="Edit this proposed collaboration" />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          <Button size="sm" variant="outline" disabled={!draft.trim() || saving} onClick={save}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* The text takes the room and wraps within it; the actions stay on its
          line at the right, so Join lines up from row to row. On a narrow
          screen, and when the Join form opens, they move below. */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* The proposal is an action: clicking it opens that action with its details. */}
        <button
          type="button"
          onClick={() => navigate(`/actions/${collaboration.id}`)}
          className="flex min-w-[12rem] flex-1 basis-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-sm text-left hover:underline"
        >
          <span className="text-sm break-words">{collaboration.title}</span>
          {collaboration.created_by_name && <NameChip name={collaboration.created_by_name} />}
          {collaboration.participants.length > 0 && (
            <span className="text-xs text-muted-foreground">{collaboration.participants.length} joined</span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {mine && open && (
            <Button
              variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" aria-label="Edit this proposed collaboration"
              onClick={() => setDraft(collaboration.title)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          {mine && untouched && mine.options.length === 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" aria-label="Delete this proposed collaboration">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this?</AlertDialogTitle>
                  <AlertDialogDescription>
                    "{collaboration.title}" is removed for good, for you and for anyone who could see it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onDelete(collaboration.id)}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        {open && <TakePart goalId={collaboration.id} joined={!!userId && collaboration.participants.includes(userId)} />}
      </div>

      {/* Rewards on it: everyone sees what is offered and the tally; its author can add one. */}
      {(collaboration.rewards ?? mine?.rewards ?? []).map(reward => (
        <RewardOffer key={reward.id} reward={reward} organizationId={organizationId} userId={userId} />
      ))}
      {mine && open && <AddReward organizationId={organizationId} actionId={collaboration.id} />}

      {!!mine?.taking_part?.length && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Joined</p>
          {mine.taking_part.map(person => (
            <div key={person.id} className="space-y-1 text-sm">
              <NameChip name={person.name || 'Someone'} />
              {person.comments.map((comment, i) => (
                <p key={i} className="break-words text-muted-foreground">{comment}</p>
              ))}
            </div>
          ))}
        </div>
      )}
      {mine && open && linkTo && <AddressesChallenge goal={mine} challenges={linkTo} />}
    </div>
  );
}

// Situations (stored as challenges): how things are for people in the org, stated
// without a solution. Anyone can add one, vote for
// the ones that matter to them too, and propose a collaboration for one.
// `goals` are the viewer's own proposed collaborations: they give the author's
// extras on a row, and the ones not linked to any challenge yet are listed last.
// `members` are the people of the org and of the viewer's own orgs, for
// assigning a challenge when editing it (its voters can be assigned too).
export function ChallengesSection({ organizationId, challenges, goals = [], members = [] }: {
  organizationId: string;
  challenges: Challenge[];
  goals?: MyGoal[];
  members?: { id: string; name: string | null }[];
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const createChallenge = useCreateChallenge();
  const vote = useVoteForChallenge();
  const createGoal = useCreateGoal();
  const remove = useDeleteGoal(organizationId);
  const [text, setText] = useState('');
  const [proposingFor, setProposingFor] = useState<string | null>(null);
  const [proposal, setProposal] = useState('');
  const editChallenge = useEditChallenge();
  const [editing, setEditing] = useState<{ id: string; text: string; assignedTo: string } | null>(null);

  const saveEdit = () =>
    editing && editChallenge.mutate({ organizationId, id: editing.id, text: editing.text.trim(), assignedTo: editing.assignedTo }, {
      onSuccess: () => setEditing(null),
      onError: failed('Could not save the change'),
    });

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: errorMessage(error), variant: 'destructive' });

  const add = () =>
    createChallenge.mutate({ organizationId, challenge: text.trim() }, {
      onSuccess: () => setText(''),
      onError: failed('Could not add it'),
    });

  const propose = (challengeId: string) =>
    createGoal.mutate({ organization_id: organizationId, desired_state: proposal.trim(), challenge_id: challengeId }, {
      onSuccess: () => {
        setProposingFor(null);
        setProposal('');
      },
      onError: failed('Could not propose it'),
    });

  // Who a challenge can be assigned to: the organization's people, and anyone who voted for it.
  const assignable = (challenge: Challenge) => {
    const people = [{ id: challenge.owner, name: challenge.owner_name }, ...members, ...(challenge.voters ?? [])];
    return people
      .filter((person, i) => people.findIndex(other => other.id === person.id) === i)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  };

  const editCollaboration = (id: string, text: string) =>
    editChallenge.mutateAsync({ organizationId, id, text }).then(() => true, error => {
      failed('Could not save the change')(error);
      return false;
    });

  const deleteItem = (id: string) => remove.mutate(id, { onError: failed('Could not delete it') });
  // My proposals that aren't under any challenge above would otherwise have nowhere to show.
  const unlinked = goals.filter(g => !g.addresses?.length);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Where we could improve</h2>
      <p className="text-sm text-muted-foreground">
        Describe how things are. It doesn't need a solution: those come afterwards, as proposed collaborations.
      </p>

      <div className="space-y-2">
        <Textarea
          rows={2}
          placeholder="How things are"
          value={text}
          onChange={e => setText(e.target.value)}
          aria-label="Describe where we could improve"
        />
        <div className="flex justify-end">
          {/* The page's one filled button, in the Positive Sum orange rather than the app's near-black. */}
          <Button
            size="sm" className="bg-orange-500 text-white hover:bg-orange-600"
            disabled={!text.trim() || createChallenge.isPending} onClick={add}
          >
            {createChallenge.isPending ? 'Adding...' : 'Add'}
          </Button>
        </div>
      </div>

      {challenges.length === 0 && <p className="text-sm text-muted-foreground">Nothing here yet.</p>}

      {challenges.map(challenge => {
        const mine = challenge.owner === user?.userId;
        return (
          <Card key={challenge.id}>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-start gap-3">
                {/* "This affects me too": a raised hand and how many people share the situation.
                    Outlined until you raise yours, amber after. Not a thumbs-up — nobody likes a problem. */}
                <button
                  type="button"
                  disabled={challenge.voted_by_me || vote.isPending}
                  onClick={() => vote.mutate(challenge.id, { onError: failed('Could not vote') })}
                  aria-label={`${challenge.voted_by_me ? 'This affects you too' : 'This affects me too'}, ${challenge.votes} ${challenge.votes === 1 ? 'person shares' : 'people share'} it`}
                  title={challenge.voted_by_me ? 'This affects you too' : 'This affects me too'}
                  className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-sm transition-colors ${
                    challenge.voted_by_me
                      ? 'border-amber-600 bg-amber-100 text-amber-900 dark:border-amber-500 dark:bg-amber-900/40 dark:text-amber-100'
                      : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <Hand className="h-4 w-4" aria-hidden />
                  {challenge.votes}
                </button>

                <div className="min-w-0 flex-1 space-y-2">
                  {editing?.id === challenge.id ? (
                    <div className="space-y-2">
                      <Textarea
                        rows={2}
                        value={editing.text}
                        onChange={e => setEditing({ ...editing, text: e.target.value })}
                        aria-label="Edit this"
                      />
                      {assignable(challenge).length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-muted-foreground">Assigned to</span>
                          <Select value={editing.assignedTo} onValueChange={assignedTo => setEditing({ ...editing, assignedTo })}>
                            <SelectTrigger className="h-9 w-full sm:w-64" aria-label="Assigned to">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {assignable(challenge).map(person => (
                                <SelectItem key={person.id} value={person.id}>{person.name || 'Unnamed'}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                        <Button size="sm" variant="outline" disabled={!editing.text.trim() || editChallenge.isPending} onClick={saveEdit}>
                          {editChallenge.isPending ? 'Saving...' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      {/* The assignee follows the title on the same line, and wraps under it when there is no room. */}
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-lg font-semibold leading-snug break-words">{challenge.text}</p>
                        {challenge.owner_name && <NameChip name={challenge.owner_name} />}
                      </div>
                      {/* Only its owner. Deleting only while nobody has voted or proposed anything for it. */}
                      {mine && (
                        <div className="flex shrink-0">
                          <Button
                            variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Edit this"
                            onClick={() => setEditing({ id: challenge.id, text: challenge.text, assignedTo: challenge.owner })}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          {challenge.votes === 0 && challenge.collaborations.length === 0 && (
                            <Button
                              variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Delete this"
                              onClick={() => deleteItem(challenge.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* What is proposed for this situation hangs off it: indented under
                  the title, with a rule down the side. */}
              <div className="ml-3 space-y-3 border-l-2 border-border pl-4">
                {challenge.collaborations.length > 0 && (
                  <p className="text-xs font-medium text-muted-foreground">
                    {challenge.collaborations.length} proposed {challenge.collaborations.length === 1 ? 'collaboration' : 'collaborations'}
                  </p>
                )}
                {challenge.collaborations.map(collaboration => (
                  <CollaborationRow
                    key={collaboration.id}
                    collaboration={collaboration}
                    mine={goals.find(g => g.id === collaboration.id)}
                    userId={user?.userId}
                    organizationId={organizationId}
                    onDelete={deleteItem}
                    onEdit={editCollaboration}
                  />
                ))}
                {proposingFor === challenge.id ? (
                  <div className="space-y-2">
                    <Textarea
                      rows={2}
                      placeholder="What could we do together about this?"
                      value={proposal}
                      onChange={e => setProposal(e.target.value)}
                      aria-label="What could we do together about this?"
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setProposingFor(null)}>Cancel</Button>
                      <Button size="sm" variant="outline" disabled={!proposal.trim() || createGoal.isPending} onClick={() => propose(challenge.id)}>
                        {createGoal.isPending ? 'Saving...' : 'Propose'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm" variant="ghost" className="h-8 gap-1 px-2 text-muted-foreground"
                    onClick={() => { setProposingFor(challenge.id); setProposal(''); }}
                  >
                    <Plus className="h-4 w-4" />
                    Propose a collaboration
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {unlinked.length > 0 && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Your proposed collaborations not placed under anything above</p>
            {unlinked.map(goal => (
              <CollaborationRow
                key={goal.id}
                collaboration={{
                  id: goal.id, title: goal.title, status: goal.status,
                  created_by: goal.created_by, created_by_name: null, participants: goal.participants ?? [],
                }}
                mine={goal}
                linkTo={challenges}
                userId={user?.userId}
                organizationId={organizationId}
                onDelete={deleteItem}
                onEdit={editCollaboration}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
