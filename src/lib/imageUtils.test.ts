import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openImage, showDisplayedIfOriginalMissing } from './imageUtils';

const BUCKET = 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com';
const KEY = 'organizations/org-1/images/welder.jpg';
const DISPLAYED = `${BUCKET}/${KEY}`;
const ORIGINAL = `${BUCKET}/organizations/org-1/images/uploads/welder.jpg`;

describe('openImage', () => {
  // The probe image: tests decide whether the original loads.
  let probes: { src: string; onload?: () => void; onerror?: () => void }[];
  let tab: { location: { href: string } };
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    probes = [];
    tab = { location: { href: '' } };
    open = vi.fn(() => tab);
    vi.stubGlobal('open', open);
    vi.stubGlobal('Image', class { src = ''; onload?: () => void; onerror?: () => void; constructor() { probes.push(this); } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the original when one was kept', () => {
    openImage(KEY);
    expect(open).toHaveBeenCalledWith('', '_blank'); // at once, inside the click
    expect(probes[0].src).toBe(ORIGINAL);
    probes[0].onload!();
    expect(tab.location.href).toBe(ORIGINAL);
  });

  it('opens the displayed image when there is no original', () => {
    openImage(KEY);
    probes[0].onerror!();
    expect(tab.location.href).toBe(DISPLAYED);
  });

  it('opens the image directly when no original can be derived', () => {
    openImage('https://example.com/photo.jpg');
    expect(open).toHaveBeenCalledWith('https://example.com/photo.jpg', '_blank');
    expect(probes).toHaveLength(0);
  });

  it('does nothing without an image', () => {
    openImage(null);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('showDisplayedIfOriginalMissing', () => {
  const failed = (src: string) => {
    const img = { src } as HTMLImageElement;
    showDisplayedIfOriginalMissing({ currentTarget: img });
    return img.src;
  };

  it('swaps a missing original for the image the app displays', () => {
    expect(failed(ORIGINAL)).toBe(DISPLAYED);
    expect(failed(`${BUCKET}/mission-attachments/uploads/abc-file.jpg`)).toBe(`${BUCKET}/mission-attachments/abc-file.jpg`);
  });

  it('leaves any other image alone, so a broken one cannot loop', () => {
    expect(failed(DISPLAYED)).toBe(DISPLAYED);
    expect(failed('https://example.com/photo.jpg')).toBe('https://example.com/photo.jpg');
  });
});
