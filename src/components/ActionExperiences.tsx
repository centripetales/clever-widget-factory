import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Label } from '@/components/ui/label';
import { useExperiences } from '@/hooks/useExperiences';
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
export function ActionExperiences({ actionId }: { actionId: string }) {
  const { data } = useExperiences({ action_id: actionId });
  const experiences = data?.data ?? [];
  if (experiences.length === 0) return null;

  return (
    <div className="space-y-1">
      <Label className="text-sm font-medium">Experiences</Label>
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
