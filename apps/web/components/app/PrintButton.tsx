"use client";

/** Opens the browser's print dialog (save as PDF from there). */
export function PrintButton({ label }: { label: string }) {
  return <button type="button" className="secondary no-print" onClick={() => window.print()}>{label}</button>;
}
