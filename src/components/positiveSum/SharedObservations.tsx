import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useEditSharedObservation } from '@/hooks/positiveSum/usePositiveSum';
import { errorMessage } from '@/lib/apiService';
import { getThumbnailUrl, openImage } from '@/lib/imageUtils';
import { flyCoin } from '@/lib/coinFly';
import type { SharedObservation } from '@/types/positiveSum';

const peso = (n: number) => `₱${Math.round(n).toLocaleString()}`;
const SHOWN_AT_FIRST = 3;
const rowId = (id: string) => `shared-observation-${id}`;
const short = (text: string) => (text.length > 70 ? `${text.slice(0, 70).trimEnd()}…` : text);

// What an observation was credited, or where its reading is. When a person's
// own reading arrives while they watch, a coin flies from the feedback (`from`)
// to the amount, which shows once it lands; again each time they press it.
function Credit({ observation, from }: { observation: SharedObservation; from: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const before = useRef(observation.reading);
  const celebrates = observation.mine && observation.reading === 'read' && !!observation.php;
  // Before the browser paints, so the amount never shows ahead of its coin.
  useLayoutEffect(() => {
    if (before.current === 'waiting' && celebrates && ref.current) flyCoin(from.current, ref.current);
    before.current = observation.reading;
  }, [observation.reading, celebrates, from]);

  const value = (
    <>
      {observation.was_php !== null && <span className="font-normal text-muted-foreground">{peso(observation.was_php)} → </span>}
      <span ref={ref} className={`inline-block ${observation.php ? 'font-semibold text-green-600 dark:text-green-400' : ''}`}>
        {peso(observation.php ?? 0)}
      </span>
    </>
  );
  const amount = observation.php === null ? null : celebrates ? (
    <button
      type="button" onClick={() => ref.current && flyCoin(from.current, ref.current)}
      className="font-medium" title="Play it again"
    >
      {value}
    </button>
  ) : (
    <span className="font-medium">{value}</span>
  );
  if (observation.reading === 'waiting') {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Reading…{amount && <> so far {amount}</>}
      </span>
    );
  }
  if (observation.reading === 'unread') return <span className="text-muted-foreground">Not read yet{amount && <> · so far {amount}</>}</span>;
  return amount;
}

// An observation's photos with what was written on each. A copy of the page
// data saved in the browser before photos were listed has one photo and the
// captions as a single text instead; those show, and are edited once the fresh
// list arrives.
function listedPhotos(observation: SharedObservation): { url: string; description: string; editable: boolean }[] {
  if (observation.photos) return observation.photos.map(photo => ({ ...photo, editable: true }));
  const saved = observation as SharedObservation & { photo?: string | null; captions?: string };
  return saved.photo || saved.captions ? [{ url: saved.photo ?? '', description: saved.captions ?? '', editable: false }] : [];
}

// What a person is changing in a row: their description, what they wrote on
// one of the photos, or a reply to the feedback (added to the description).
type Editing = { part: 'text' } | { part: 'photo'; index: number } | { part: 'reply' };

// A person's own words, which open for editing when selected. Other people's are plain text.
function Words({ text, mine, label, onEdit }: { text: string; mine: boolean; label: string; onEdit: () => void }) {
  if (!mine) return <p className="whitespace-pre-wrap break-words">{text}</p>;
  return (
    <button
      type="button" onClick={onEdit} aria-label={label} title="Edit"
      className="block w-full cursor-text whitespace-pre-wrap break-words rounded-sm text-left hover:bg-amber-100 dark:hover:bg-amber-900/40"
    >
      {text}
    </button>
  );
}

// One shared observation: the person's words, what the offer credited and why.
// Its author can edit what they wrote by selecting it, or reply to the
// feedback; either way it is read again, and the amount can rise but never falls.
// Each earlier observation the reading compared it with: whether this one builds
// on it or is the same, and a link to it when it is in the list.
function Compared({ observation, listed, onShow }: { observation: SharedObservation; listed: Set<string>; onShow: (id: string) => void }) {
  if (!observation.compared_with?.length) return null;
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      {observation.compared_with.map(earlier => {
        const label = (
          <>
            {earlier.repeats ? 'Same as' : 'Builds on'} {new Date(earlier.created_at).toLocaleDateString()} · {earlier.name || 'Someone'}:{' '}
            <span className="italic">{short(earlier.text)}</span>
          </>
        );
        const title = earlier.adds ? `Adds: ${earlier.adds}` : undefined;
        return (
          <li key={earlier.id}>
            {listed.has(earlier.id) ? (
              <button type="button" title={title} onClick={() => onShow(earlier.id)} className="text-left underline-offset-2 hover:underline">
                {label}
              </button>
            ) : <span title={title}>{label}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Row({ observation, listed, onShow, highlighted }: {
  observation: SharedObservation; listed: Set<string>; onShow: (id: string) => void; highlighted: boolean;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const edit = useEditSharedObservation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const feedbackRef = useRef<HTMLButtonElement>(null);
  const photos = listedPhotos(observation);

  const open = (target: Editing, text: string) => {
    setEditing(target);
    setDraft(text);
  };
  const original = !editing || editing.part === 'reply' ? '' : editing.part === 'text' ? observation.text : photos[editing.index].description;
  const save = () => {
    if (!editing) return;
    const text = draft.trim();
    const change = editing.part === 'photo'
      ? { photos: photos.map((photo, i) => ({ url: photo.url, description: i === editing.index ? text : photo.description })) }
      : { text: editing.part === 'reply' ? [observation.text.trim(), text].filter(Boolean).join('\n\n') : text };
    edit.mutate({ id: observation.id, ...change }, {
      onSuccess: () => setEditing(null),
      onError: error => toast({ title: 'Could not save it', description: errorMessage(error), variant: 'destructive' }),
    });
  };
  const box = (label: string) => (
    <div className="space-y-2">
      <Textarea rows={3} autoFocus value={draft} onChange={e => setDraft(e.target.value)} aria-label={label} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        <Button size="sm" variant="outline" onClick={save} disabled={!draft.trim() || draft.trim() === original.trim() || edit.isPending}>
          {edit.isPending ? 'Saving...' : 'Save and read again'}
        </Button>
      </div>
    </div>
  );

  return (
    // Laid out like a card on the Observations page: who and when, the words, then the photos in a row.
    <li id={rowId(observation.id)} className={`space-y-3 rounded-lg border bg-background p-3 transition-shadow ${highlighted ? 'ring-2 ring-orange-400' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{observation.name || (observation.mine ? 'You' : 'Someone')}</span>
          <span className="text-xs text-muted-foreground">•</span>
          <span className="text-xs text-muted-foreground">{new Date(observation.created_at).toLocaleString()}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Credit observation={observation} from={feedbackRef} />
          {observation.mine && (
            <Button
              variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Open this observation to edit it"
              onClick={() => navigate(`/observations/edit/${observation.id}`)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-2 text-sm leading-relaxed text-foreground/90">
        {editing?.part === 'text'
          ? box('What you wrote')
          : observation.text && (
            <Words text={observation.text} mine={observation.mine} label="Edit what you wrote" onEdit={() => open({ part: 'text' }, observation.text)} />
          )}
        {photos.map((photo, index) => (editing?.part === 'photo' && editing.index === index
          ? <div key={photo.url || index}>{box('What you wrote on the photo')}</div>
          : photo.description && (
            <Words
              key={photo.url || index} text={photo.description} mine={observation.mine && photo.editable}
              label="Edit what you wrote on the photo" onEdit={() => open({ part: 'photo', index }, photo.description)}
            />
          )))}
      </div>

      {photos.some(photo => photo.url) && (
        <div className="flex gap-2.5 overflow-x-auto py-1">
          {photos.filter(photo => photo.url).map((photo, index) => (
            <img
              key={photo.url} src={getThumbnailUrl(photo.url) || photo.url} alt={`Photo ${index + 1}`}
              className="h-24 w-24 shrink-0 cursor-pointer rounded-lg border bg-muted object-cover hover:opacity-90"
              onClick={() => openImage(photo.url)}
            />
          ))}
        </div>
      )}

      {/* What the offer said about it matters less: one line, opened on request. */}
      {observation.feedback && (
        <button
          type="button" ref={feedbackRef} onClick={() => setShowFeedback(!showFeedback)} aria-expanded={showFeedback}
          className={`block w-full break-words text-left text-xs text-muted-foreground ${showFeedback ? '' : 'truncate'}`}
        >
          {observation.feedback}
        </button>
      )}
      <Compared observation={observation} listed={listed} onShow={onShow} />
      {editing?.part === 'reply' && box('Your reply')}
      {observation.mine && !editing && (
        <Button size="sm" variant="ghost" className="h-7 px-1 text-xs" onClick={() => open({ part: 'reply' }, '')}>
          Reply
        </Button>
      )}
    </li>
  );
}

// The observations shared for an offer: a person's own (the offer's owner sees
// everyone's), newest first.
export function SharedObservations({ observations, payerName }: { observations: SharedObservation[]; payerName: string }) {
  const [all, setAll] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  // Going to an earlier observation: the whole list opens, it scrolls into view and is outlined for a moment.
  useEffect(() => {
    if (!focus) return;
    document.getElementById(rowId(focus))?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    const done = setTimeout(() => setFocus(null), 2000);
    return () => clearTimeout(done);
  }, [focus]);
  if (observations.length === 0) return null;
  const listed = new Set(observations.map(o => o.id));
  const show = (id: string) => {
    setAll(true);
    setFocus(id);
  };
  const shown = all ? observations : observations.slice(0, SHOWN_AT_FIRST);
  const stuck = observations.some(o => o.mine && o.reading === 'unread');

  return (
    <div className="space-y-2">
      <ul className="space-y-3">
        {shown.map(observation => (
          <Row key={observation.id} observation={observation} listed={listed} onShow={show} highlighted={focus === observation.id} />
        ))}
      </ul>
      {stuck && (
        <p className="text-xs text-muted-foreground">
          Nothing is lost when one has not been read: change what you wrote and it is read again, or ask {payerName}.
        </p>
      )}
      {observations.length > SHOWN_AT_FIRST && (
        <Button variant="ghost" size="sm" className="h-7 px-1 text-xs text-muted-foreground" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${observations.length}`}
        </Button>
      )}
    </div>
  );
}
