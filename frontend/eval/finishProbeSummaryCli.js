// Entry for the closing summary of finish-probe v1-v3:
//   node frontend/eval/finishProbeSummaryCli.js --phase report [--readme]
//   node frontend/eval/finishProbeSummaryCli.js --phase analysis --live
import { installBrowserShims } from './bootstrap.js';

// The shims go in before any eval module is loaded.
installBrowserShims();
const { flagValue } = await import('./noteTools.js');
const argv = process.argv.slice(2);
const phase = flagValue(argv, '--phase');
if (phase !== 'report' && phase !== 'analysis') {
  throw new Error('Usage: finishProbeSummaryCli.js --phase report [--readme] | --phase analysis --live');
}
if (phase === 'analysis' && !argv.includes('--live')) throw new Error('analysis posts only with --live');
const { runSummaryAnalysis, runSummaryReport } = await import('./finishProbeSummary.js');
process.exitCode = phase === 'report' ? runSummaryReport(argv) : await runSummaryAnalysis();
