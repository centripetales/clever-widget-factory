import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { listExperiences } from '@/lib/apiService';
import { experiencesQueryKey } from '@/lib/queryKeys';
import type { Experience } from '@/types/experiences';

// An experience is open while an action in it is not completed. A reopened
// action keeps its old completion date, so its status decides; the date is
// only a fallback for a response without it.
const isOpen = (experience: Experience) =>
  (experience.components?.actions || []).some((c) =>
    c.action && (c.action.status ? c.action.status !== 'completed' : !c.action.completed_at));

// What it is about, in a few words: its action, otherwise the first
// observation in it that has text.
const summary = (experience: Experience) => {
  const c = experience.components;
  const text = [
    ...(c?.actions || []).map((a) => a.action?.title),
    ...[...(c?.initial_states || []), ...(c?.final_states || [])].map((s) => s.state?.state_text),
  ].find((t) => t?.trim())?.trim() || '';
  if (!text) return 'No observations yet';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

// Every experience in the organization, open ones first, newest first.
export default function Experiences() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    // The unfiltered key, which creating an experience already refreshes.
    queryKey: experiencesQueryKey(),
    queryFn: () => listExperiences({ limit: 200 }),
    staleTime: 30 * 1000,
    refetchOnMount: true,
  });
  const experiences = data?.data ?? [];
  const open = experiences.filter(isOpen);
  const closed = experiences.filter((e) => !isOpen(e));

  const renderList = (list: Experience[], label: string) => list.length > 0 && (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      <ul className="space-y-2">
        {list.map((experience) => (
          <li key={experience.id}>
            <Link
              to={`/experiences/${experience.id}`}
              className={`block rounded-md border-2 px-3 py-2 text-sm hover:bg-muted break-words ${
                isOpen(experience) ? 'border-yellow-400' : 'border-green-500'
              }`}
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{format(new Date(experience.created_at), 'MMM d, yyyy')}</span>
                {experience.entity && 'name' in experience.entity && <span>· {experience.entity.name}</span>}
              </div>
              <div>{summary(experience)}</div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="min-h-screen bg-background p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <h1 className="text-xl font-semibold">Experiences</h1>
      </div>
      {isLoading ? (
        <div className="flex items-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading experiences…
        </div>
      ) : experiences.length === 0 ? (
        <p className="text-sm text-muted-foreground">No experiences yet.</p>
      ) : (
        <>
          {renderList(open, 'Open')}
          {renderList(closed, 'Closed')}
        </>
      )}
    </div>
  );
}
