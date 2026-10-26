/**
 * Halloween decorations for the staff CRM (lib/seasonalTheme.ts decides when).
 * Plain SVG and CSS, no script: spider webs in the top corners with a spider
 * bobbing on its thread, glowing jack-o'-lanterns bottom-left, and ghosts that
 * drift across now and then. Never blocks a click (pointer-events: none), sits
 * under every dialog and the Ask bubble, keeps still for reduced motion, and
 * never prints. Hidden from screen readers.
 */

/** A corner web as SVG paths, drawn from the corner (0,0) out to `size`. */
function webPaths(size: number): string[] {
  const spokes = 7;
  const rings = [0.28, 0.48, 0.68, 0.88];
  const angle = (i: number) => (Math.PI / 2) * (i / (spokes - 1));
  const point = (r: number, i: number) => [Math.cos(angle(i)) * r * size, Math.sin(angle(i)) * r * size];
  const paths = Array.from({ length: spokes }, (_, i) => {
    const [x, y] = point(1, i);
    return `M0 0 L${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  for (const r of rings) {
    // Threads sag a little towards the corner between spokes, like a real web.
    let d = "";
    for (let i = 0; i < spokes; i++) {
      const [x, y] = point(r, i);
      if (i === 0) d += `M${x.toFixed(1)} ${y.toFixed(1)}`;
      else {
        const [mx, my] = point(r * 0.9, i - 0.5);
        d += ` Q${mx.toFixed(1)} ${my.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
    }
    paths.push(d);
  }
  return paths;
}

function Web({ className }: { className: string }) {
  return (
    <svg className={`hw-web ${className}`} viewBox="0 0 190 190" width="190" height="190">
      {webPaths(190).map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="1.1" />
      ))}
    </svg>
  );
}

function Pumpkin({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={`hw-pumpkin ${className ?? ""}`} viewBox="0 0 64 60" width={size} height={size * (60 / 64)}>
      <path d="M31 10c0-5 2-8 6-9" stroke="#3f6212" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <ellipse cx="18" cy="35" rx="14" ry="20" fill="#ea580c" />
      <ellipse cx="46" cy="35" rx="14" ry="20" fill="#ea580c" />
      <ellipse cx="32" cy="35" rx="15" ry="22" fill="#f97316" />
      <g className="hw-face" fill="#fde047">
        <path d="M20 29l6-5 3 7z" />
        <path d="M44 29l-6-5-3 7z" />
        <path d="M17 41c5 7 25 7 30 0l-4 1-3 4-4-3-4 3-4-3-4 3-3-4z" />
      </g>
    </svg>
  );
}

function Ghost({ className }: { className: string }) {
  return (
    <svg className={`hw-ghost ${className}`} viewBox="0 0 40 48" width="40" height="48">
      <path d="M20 2C9 2 4 11 4 21v24l5-4 5 4 6-4 6 4 5-4 5 4V21C36 11 31 2 20 2z" fill="#f8fafc" />
      <ellipse cx="14" cy="19" rx="2.6" ry="3.6" fill="#1e1b4b" />
      <ellipse cx="26" cy="19" rx="2.6" ry="3.6" fill="#1e1b4b" />
      <ellipse cx="20" cy="29" rx="3" ry="2.2" fill="#1e1b4b" />
    </svg>
  );
}

export default function HalloweenDecor() {
  return (
    <div className="hw-decor" aria-hidden="true">
      <Web className="hw-web-left" />
      <Web className="hw-web-right" />
      <div className="hw-spider">
        <div className="hw-thread" />
        {/* Pale against the dark app — a black spider vanished into it. */}
        <svg viewBox="0 0 30 26" width="34" height="29">
          <g stroke="#c4b5fd" strokeWidth="1.7" fill="none" strokeLinecap="round">
            <path d="M10 12L2 6M10 14L1 14M10 16L2 22M11 18L5 25" />
            <path d="M20 12L28 6M20 14L29 14M20 16L28 22M19 18L25 25" />
          </g>
          <ellipse cx="15" cy="15" rx="6" ry="7" fill="#a78bfa" />
          <circle cx="15" cy="7" r="4" fill="#a78bfa" />
          <circle cx="13.5" cy="6.4" r="1.2" fill="#fb923c" />
          <circle cx="16.5" cy="6.4" r="1.2" fill="#fb923c" />
        </svg>
      </div>
      <div className="hw-pumpkins">
        <Pumpkin size={72} />
        <Pumpkin size={48} className="hw-pumpkin-small" />
        <Pumpkin size={58} className="hw-pumpkin-mid" />
      </div>
      <Ghost className="hw-ghost-1" />
      <Ghost className="hw-ghost-2" />
    </div>
  );
}
