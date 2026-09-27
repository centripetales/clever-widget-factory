interface PositiveSumIconProps {
  className?: string;
}

// "1+1=3" — the positive-sum idea: together we create more than we put in.
// Drawn in currentColor so it takes the tile's text color.
export function PositiveSumIcon({ className }: PositiveSumIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label="Positive Sum (1+1=3)"
    >
      <text
        x="24"
        y="29.5"
        textAnchor="middle"
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="15"
        fontWeight="700"
        letterSpacing="-0.5"
      >
        1+1=3
      </text>
    </svg>
  );
}
