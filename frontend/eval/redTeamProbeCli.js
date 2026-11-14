// Entry for redteam-probe-v1 (redteam-probe-v1-protocol.md), from frontend/:
//   node eval/redTeamProbeCli.js --phase inspect          (no POST: gate G0, numbers, worst case)
//   node eval/redTeamProbeCli.js --phase smoke --live     (3 pilot questions, outside the result)
//   node eval/redTeamProbeCli.js --phase run --live       (RT, C, Rc on the test questions)
//   node eval/redTeamProbeCli.js --phase product --live   (the Rp calls that need their own call)
//   node eval/redTeamProbeCli.js --phase report           (no POST)
import { installBrowserShims } from './bootstrap.js';

// The shims go in before any eval module is loaded.
installBrowserShims();
const { flagValue } = await import('./noteTools.js');
const argv = process.argv.slice(2);
const phase = flagValue(argv, '--phase');
const LIVE = { smoke: 'smoke', run: 'test', product: 'product' };
if (!['inspect', 'report', ...Object.keys(LIVE)].includes(phase)) {
  throw new Error('Usage: redTeamProbeCli.js --phase inspect | report | smoke --live | run --live | product --live');
}
if (LIVE[phase] && !argv.includes('--live')) throw new Error(`--phase ${phase} posts only with --live`);
const probe = await import('./redTeamProbe.js');
if (phase === 'inspect') process.exitCode = await probe.runInspect();
else if (phase === 'report') process.exitCode = await probe.runReport();
else process.exitCode = await probe.runLive(LIVE[phase], { argv });
