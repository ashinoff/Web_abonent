import { planCompactWorkbooks, buildCompactWorkbook } from './anomaly-report.js';
import { journalReportSheet } from './journal-report-data.js';

export function planJournalWorkbooks(report, context = {}, options = {}) {
  return planCompactWorkbooks(journalReportSheet(report, context), context, options);
}
export function buildJournalWorkbook(report, XLSX, context = {}) {
  return buildCompactWorkbook(journalReportSheet(report, context), XLSX, context);
}
