// Shared stage/task-type color assignment so every dashboard widget that
// breaks deliveries down by stage (the Delivery Calendar, By Month · Stage
// Breakdown) colors the same stage name the same way.
export const STAGE_PALETTE = [
  "#1d4e6d",
  "#3f7fa6",
  "#7fb3d5",
  "#f26b22",
  "#8faa3c",
  "#a56cc1",
  "#c2410c",
  "#0f766e",
];

export function stageColor(name: string, order: string[]): string {
  const idx = order.indexOf(name);
  return STAGE_PALETTE[idx >= 0 ? idx % STAGE_PALETTE.length : 0];
}
