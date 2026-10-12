// The app's one loading indicator. Self-contained: its keyframes ship with
// the component, so mounting it anywhere animates without extra global CSS.
// `currentColor` is what makes it reusable — it picks up the color of
// whatever it is loading (white inside a primary button, blue on a card,
// pale on the dark session loader) instead of hard-coding one.
const SWIRLING_STYLES = `
  @keyframes loading-ui-swirling-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes loading-ui-swirling-dash {
    0% {
      stroke-dasharray: 1, 800;
      stroke-dashoffset: 0;
    }
    50% {
      stroke-dasharray: 400, 400;
      stroke-dashoffset: -200px;
    }
    100% {
      stroke-dasharray: 800, 1;
      stroke-dashoffset: -800px;
    }
  }

  .loading-ui-swirling-circle {
    transform-origin: center;
    animation:
      loading-ui-swirling-dash var(--duration, 1.5s) ease-in-out infinite alternate,
      loading-ui-swirling-spin calc(var(--duration, 1.5s) * 1.333333) linear infinite;
  }
`;

function Swirling({ size = 56, duration = '1.5s', className, style, ...props }) {
  return (
    <>
      <style>{SWIRLING_STYLES}</style>
      <svg
        aria-hidden="true"
        className={`loading-ui-swirling${className ? ` ${className}` : ''}`}
        height={size}
        role="presentation"
        style={{ '--duration': duration, ...style }}
        viewBox="0 0 800 800"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <circle
          className="loading-ui-swirling-circle"
          cx="400"
          cy="400"
          fill="none"
          r="200"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="50"
        />
      </svg>
    </>
  );
}

export { Swirling };
export default Swirling;
