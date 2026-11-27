import { ArrowUp, Check } from "lucide-react";
import type { CarriagewayType, VergeSide } from "@/lib/domain/assessment-types";

interface CarriagewayDiagramProps {
  carriageway: CarriagewayType;
  selectedSides: VergeSide[];
  directionLabel: string;
  onToggleSide: (side: VergeSide) => void;
}

const SIDE_LABELS: Record<VergeSide, string> = {
  left: "Left verge",
  right: "Right verge",
  outer_a: "Outer A",
  inner_a: "Inner A",
  inner_b: "Inner B",
  outer_b: "Outer B",
  shared_median: "Shared median (1 strip)",
};

export function CarriagewayDiagram({
  carriageway,
  selectedSides,
  directionLabel,
  onToggleSide,
}: CarriagewayDiagramProps) {
  const isSelected = (side: VergeSide) => selectedSides.includes(side);

  const stripBtnClass = (side: VergeSide) =>
    `flex min-h-20 flex-col items-center justify-center gap-1 rounded-md border-2 px-2 py-3 text-center text-xs font-semibold transition-colors ${
      isSelected(side)
        ? "border-accent bg-accent/25 text-foreground"
        : "border-dashed border-border bg-muted/40 text-muted-foreground hover:bg-muted"
    }`;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Tap verges to include</span>
        <span className="inline-flex items-center gap-1 font-medium">
          <ArrowUp className="h-3.5 w-3.5" />
          {directionLabel || "Start → End direction"}
        </span>
      </div>

      {carriageway === "single" ? (
        <div className="grid grid-cols-3 items-stretch gap-2">
          <button type="button" onClick={() => onToggleSide("left")} className={stripBtnClass("left")}>
            {isSelected("left") && <Check className="h-4 w-4 text-status-ok" />}
            <span>{SIDE_LABELS.left}</span>
          </button>
          <div className="flex flex-col items-center justify-center rounded-md bg-primary px-2 py-4 text-center text-xs font-semibold text-primary-foreground">
            <ArrowUp className="mb-1 h-4 w-4" />
            <span>Road</span>
            <span className="text-[10px] opacity-80">Single</span>
          </div>
          <button type="button" onClick={() => onToggleSide("right")} className={stripBtnClass("right")}>
            {isSelected("right") && <Check className="h-4 w-4 text-status-ok" />}
            <span>{SIDE_LABELS.right}</span>
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-5 items-stretch gap-1.5">
            <button type="button" onClick={() => onToggleSide("outer_a")} className={stripBtnClass("outer_a")}>
              {isSelected("outer_a") && <Check className="h-4 w-4 text-status-ok" />}
              <span>{SIDE_LABELS.outer_a}</span>
            </button>
            <div className="flex flex-col items-center justify-center rounded-md bg-primary px-1 py-3 text-center text-[11px] font-semibold text-primary-foreground">
              <ArrowUp className="mb-1 h-3.5 w-3.5" />
              <span>Road A</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <button type="button" onClick={() => onToggleSide("inner_a")} className={stripBtnClass("inner_a")}>
                {isSelected("inner_a") && <Check className="h-3.5 w-3.5 text-status-ok" />}
                <span>{SIDE_LABELS.inner_a}</span>
              </button>
              <button type="button" onClick={() => onToggleSide("inner_b")} className={stripBtnClass("inner_b")}>
                {isSelected("inner_b") && <Check className="h-3.5 w-3.5 text-status-ok" />}
                <span>{SIDE_LABELS.inner_b}</span>
              </button>
            </div>
            <div className="flex flex-col items-center justify-center rounded-md bg-primary px-1 py-3 text-center text-[11px] font-semibold text-primary-foreground">
              <span>Road B</span>
            </div>
            <button type="button" onClick={() => onToggleSide("outer_b")} className={stripBtnClass("outer_b")}>
              {isSelected("outer_b") && <Check className="h-4 w-4 text-status-ok" />}
              <span>{SIDE_LABELS.outer_b}</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => onToggleSide("shared_median")}
            className={`flex w-full touch-target items-center justify-center gap-2 rounded-md border-2 px-3 py-2 text-xs font-semibold transition-colors ${
              isSelected("shared_median")
                ? "border-accent bg-accent/25 text-foreground"
                : "border-dashed border-border bg-muted/40 text-muted-foreground hover:bg-muted"
            }`}
          >
            {isSelected("shared_median") && <Check className="h-4 w-4 text-status-ok" />}
            <span>Use {SIDE_LABELS.shared_median} instead of Inner A + Inner B</span>
          </button>
        </div>
      )}
    </div>
  );
}