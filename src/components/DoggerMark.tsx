// The Dogger mark: a rounded dog/bear head with two eyes and a nose, drawn with
// `currentColor` so it picks up whatever color its container sets.
export function DoggerMark({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 64 64"
            fill="none"
            role="img"
            aria-label="Dogger"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                d="M18 18 C14 13, 9.5 14, 10.5 19.5 C7.5 23.5, 7.5 29, 9.5 34 C11.5 45, 20 50.5, 32 50.5 C44 50.5, 52.5 45, 54.5 34 C56.5 29, 56.5 23.5, 53.5 19.5 C54.5 14, 50 13, 46 18 C42 15.5, 37 14.5, 32 14.5 C27 14.5, 22 15.5, 18 18 Z"
                stroke="currentColor"
                strokeWidth="3.4"
                strokeLinejoin="round"
                strokeLinecap="round"
            />
            <g fill="currentColor">
                <ellipse cx="24.5" cy="31" rx="2.6" ry="3.3" />
                <ellipse cx="39.5" cy="31" rx="2.6" ry="3.3" />
                <ellipse cx="32" cy="39" rx="3.1" ry="2.7" />
            </g>
        </svg>
    );
}
