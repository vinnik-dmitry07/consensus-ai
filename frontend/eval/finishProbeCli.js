// Entry for finish-probe-v2 after its main pass, under finish-probe-v2-addendum.md.
// run.js and the v2 runner stay frozen, so these phases have an entry of their own:
//   node frontend/eval/finishProbeCli.js finish-probe-v2 --phase route-check
//   node frontend/eval/finishProbeCli.js finish-probe-v2 --phase key-audit
//   node frontend/eval/finishProbeCli.js finish-probe-v2 --phase report [--readme]
// finish-probe-v3, under finish-probe-v3-protocol.md:
//   node frontend/eval/finishProbeCli.js finish-probe-v3 --phase inspect|report [--readme]
//   node frontend/eval/finishProbeCli.js finish-probe-v3 --phase route|run|label|analysis --live
import { installBrowserShims } from './bootstrap.js';

installBrowserShims();
const argv = process.argv.slice(2);
const at = argv.indexOf('--phase');
const phase = at < 0 ? null : argv[at + 1];
if (argv[0] === 'finish-probe-v3') {
  const { runFinishProbeV3Command } = await import('./finishProbeV3.js');
  process.exitCode = await runFinishProbeV3Command(argv);
} else {
  if (argv[0] !== 'finish-probe-v2' || !['route-check', 'key-audit', 'report'].includes(phase)) {
    throw new Error('Usage: finishProbeCli.js finish-probe-v2 --phase route-check|key-audit|report [--readme]');
  }
  const { runV2ReportPhase } = await import('./finishProbeV2Report.js');
  process.exitCode = await runV2ReportPhase(phase, argv);
}
