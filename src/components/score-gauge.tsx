interface ScoreGaugeProps {
  score: number;
  size?: number;
}

export function scoreColor(score: number): string {
  if (score >= 80) return "#10b981"; // emerald-500
  if (score >= 60) return "#f59e0b"; // amber-500
  return "#f43f5e"; // rose-500
}

export function scoreVerdict(score: number): string {
  if (score >= 90) return "완벽해요! 🏆";
  if (score >= 80) return "훌륭해요! 👏";
  if (score >= 60) return "잘하고 있어요, 조금만 더!";
  if (score >= 40) return "기초가 약해요. 다시 도전해보세요!";
  return "한 번 더 연습해볼까요?";
}

/** SVG 원형 점수 게이지 */
export default function ScoreGauge({ score, size = 120 }: ScoreGaugeProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`점수: ${clamped}점`}
      className="shrink-0"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#e2e8f0"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={scoreColor(clamped)}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#0f172a"
        fontSize={size * 0.26}
        fontWeight={700}
      >
        {clamped}
      </text>
    </svg>
  );
}
