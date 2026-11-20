import type { TrashItem } from '@sti-catcher/shared';

/** Lo elegido en la papelera (D-115): cuáles siguen ahí y cuánto ocupan sus archivos. */
export function trashSummary(
  items: readonly TrashItem[],
  selected: ReadonlySet<string>,
): { ids: string[]; bytes: number } {
  const chosen = items.filter((item) => selected.has(item.id));
  return {
    ids: chosen.map((item) => item.id),
    bytes: chosen.reduce((total, item) => total + (item.trashBytes ?? 0), 0),
  };
}
