// Leave time inside the existing 300-second worker RPC for delivery, decoding
// and indexing after a large workbook has been prepared on a shared CPU.
export const PREPARATION_TIMEOUT_MS = 240000;
export const PREPARED_REQUEST_TIMEOUT_MS = 270000;
export const PREPARATION_BUILD = '2026-10-16-v23';
