// A coin that flies from one place on the page to an amount, which is stamped
// in when it lands: hidden while the coin is in the air, then pressed down
// from large and tilted. Where the person asked for less motion, or either end
// is off screen, the amount is only stamped in.

// Pressed onto the page like a rubber stamp.
function stamp(el: HTMLElement) {
  el.style.visibility = '';
  // Coming down faster and faster, then a small bounce as it settles.
  el.animate?.([
    { transform: 'scale(2.6) rotate(-14deg)', opacity: 0.3, easing: 'ease-in' },
    { transform: 'scale(0.85) rotate(2deg)', opacity: 1, offset: 0.6, easing: 'ease-out' },
    { transform: 'scale(1) rotate(0)', opacity: 1 },
  ], { duration: 420 });
}

const onScreen = (r: DOMRect) => r.bottom > 0 && r.top < window.innerHeight;

export function flyCoin(from: HTMLElement | null, to: HTMLElement) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const a = from?.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (!a || reduced || !to.animate || !onScreen(a) || !onScreen(b)) {
    stamp(to);
    return;
  }

  to.style.visibility = 'hidden';
  const size = 24;
  // From the start of the feedback line, where it begins to read.
  const start = { x: a.left + Math.min(a.width / 2, 120) - size / 2, y: a.top + a.height / 2 - size / 2 };
  const end = { x: b.left + b.width / 2 - size / 2, y: b.top + b.height / 2 - size / 2 };
  // An arc: up past the higher of the two points (staying on screen), then down onto the amount.
  const lift = Math.max(Math.min(start.y, end.y) - 80, 0);
  const point = (t: number) => ({
    x: start.x + (end.x - start.x) * t,
    y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * lift + t * t * end.y,
  });

  const coin = document.createElement('div');
  coin.textContent = '₱';
  coin.setAttribute('aria-hidden', 'true');
  coin.className = 'pointer-events-none fixed left-0 top-0 z-[100] flex items-center justify-center rounded-full border-2 border-amber-600 bg-amber-400 text-xs font-bold text-amber-900 shadow-md';
  coin.style.width = coin.style.height = `${size}px`;
  document.body.appendChild(coin);

  const steps = 12;
  const frames = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const { x, y } = point(t);
    return { transform: `translate(${x}px, ${y}px) scale(${1 + Math.sin(Math.PI * t) * 0.4}) rotateY(${t * 720}deg)` };
  });
  const flight = coin.animate(frames, { duration: 900, easing: 'ease-in-out' });
  flight.onfinish = () => {
    coin.remove();
    stamp(to);
  };
}
