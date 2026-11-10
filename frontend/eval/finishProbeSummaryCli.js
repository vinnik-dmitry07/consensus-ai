// Entry for the closing summary of finish-probe v1-v3:
//   node frontend/eval/finishProbeSummaryCli.js --phase report [--readme]
//   node frontend/eval/finishProbeSummaryCli.js --phase analysis --live
import { installBrowserShims } from './bootstrap.js';

installBrowserShims();
const argv = process.argv.slice(2);
const at = argv.indexOf('--phase');
const phase = at < 0 ? null : argv[at + 1];
if (phase === 'report') {
  const { runSummaryReport } = await import('./finishProbeSummary.js');
  process.exitCode = runSummaryReport(argv);
} else if (phase === 'analysis') {
  if (!argv.includes('--live')) throw new Error('analysis posts only with --live');
  const { runSummaryAnalysis } = await import('./finishProbeSummary.js');
  process.exitCode = await runSummaryAnalysis();
} else {
  throw new Error('Usage: finishProbeSummaryCli.js --phase report [--readme] | --phase analysis --live');
}
