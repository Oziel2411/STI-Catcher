import type { DragEvent } from 'react';

/** Arrastrar desde el escritorio (no texto ni links). */
export const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files');
