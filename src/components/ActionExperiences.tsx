import { Link, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useOrganizationId } from '@/hooks/useOrganizationId';
import { useExperiences, useCreateExperience } from '@/hooks/useExperiences';
import { useStates } from '@/hooks/useStates';
import { experienceFromAction } from '@/lib/experienceFromAction';
import type { Experience } from '@/types/experiences';

// What an experience is about, in a few words: how it turned out when that is
// recorded, otherwise how things were.
const summary = (experience: Experience) => {
  const state = experience.components?.final_states?.[0]?.state ?? experience.components?.initial_states?.[0]?.state;
  const text = state?.state_text?.trim();
  if (!text) return 'No observations yet';
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
};

// The experiences this action is part of, each opening its write-up.
export function ActionExperiences({ actionId, assetId }: { actionId: string; assetId?: string | null }) {
  const navigate = useNavigate();
  const organizationId = useOrganizationId();
  const { data } = useExperiences({ action_id: actionId });
  const { data: states } = useStates(organizationId ?? '', { entity_type: 'action', entity_id: actionId });
  const createExperience = useCreateExperience();
  const experiences = data?.data ?? [];

  const request = experienceFromAction({ id: actionId, asset_id: assetId }, states ?? []);
  if (experiences.length === 0 && !request) return null;

  const handleCreate = async () => {
    if (!request) return;
    const result = await createExperience.mutateAsync(request);
    navigate(`/experiences/${result.data.id}`);
  };

  return (
    <div className="space-y-1">
      <Label className="text-sm font-medium">Experiences</Label>
      {request && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={handleCreate} disabled={createExperience.isPending}>
            Create experience
          </Button>
        </div>
      )}
      <ul className="space-y-1">
        {experiences.map((experience) => (
          <li key={experience.id}>
            <Link
              to={`/experiences/${experience.id}`}
              className="block rounded-md border px-3 py-2 text-sm hover:bg-muted break-words"
            >
              <span className="text-muted-foreground">{format(new Date(experience.created_at), 'MMM d, yyyy')}</span>
              {' · '}
              {summary(experience)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
