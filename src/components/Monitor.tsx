import type { Metrics, Step } from "../stream/engine";
import { fmtMs } from "../stream/markdown";

function Metric({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="metric">
      <div className="m-label">{label}</div>
      <div className="m-value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {hint && <div className="m-hint">{hint}</div>}
    </div>
  );
}

export function Monitor({
  metrics,
  steps,
  open,
}: {
  metrics: Metrics;
  steps: Step[];
  open: boolean;
}) {
  return (
    <aside id="monitor" className={open ? "" : "hidden"}>
      <div className="monitor-head">
        <span className="monitor-title">Telemetry</span>
        <span className="monitor-sub">live</span>
      </div>

      <div id="metrics">
        <Metric
          label="TTFT"
          value={metrics.ttft != null ? String(metrics.ttft) : "—"}
          unit="ms"
          hint="time to first token"
        />
        <Metric
          label="Tokens/s"
          value={metrics.tps != null ? String(metrics.tps) : "—"}
          hint="completion throughput"
        />
        <Metric
          label="Latency"
          value={metrics.total != null ? fmtMs(metrics.total) : "—"}
          hint="total turn"
        />
      </div>

      <div className="monitor-section">
        <div className="monitor-section-label">Prompt tokens</div>
        <div className="monitor-big">
          {metrics.prompt != null ? metrics.prompt : "—"}
        </div>
      </div>
      <div className="monitor-section">
        <div className="monitor-section-label">Completion tokens</div>
        <div className="monitor-big">
          {metrics.completion != null ? metrics.completion : "—"}
        </div>
      </div>

      <div id="steps">
        {steps.length === 0 ? (
          <div className="steps-empty">no steps yet</div>
        ) : (
          steps.map((s) => (
            <div className="step" key={s.idx}>
              <span className="s-idx">#{s.idx}</span>
              <span className="s-bar">
                <span
                  className="s-fill"
                  style={{ width: Math.min(100, s.tokens / 4) + "%" }}
                />
              </span>
              <span className="s-meta">
                {fmtMs(s.latencyMs)} · {s.tokens}t · {s.tools}⛏
              </span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
