// Read-only evidence check. No option to bless a fake live pilot with a flag.
import { qualifySuite } from './eval-qualify.mjs';
import { runnableCaseIds } from './eval-candidate.mjs';
const suite=await qualifySuite();
const qualified=suite.cases.filter(c=>c.qualified).map(c=>c.taskId);
const runnable=runnableCaseIds.filter(id=>qualified.includes(id));
const noGo=[
  ...(!suite.qualified?['At least one trusted control case is not qualified.']:[]),
  ...(qualified.length<10?['Fewer than 10 qualified tasks.']:[]),
  ...(runnable.length<10?['Insufficient task coverage by isolated candidate verifiers.']:[]),
  'No approved spend cap, paid model routes, or observed gateway billing join on file.',
  'No blinded review or independently reviewed private/recent task set on file.'
];
console.log(JSON.stringify({schema:'jevio-eval-readiness/v1',qualified,runnable,livePilot:'NO_GO',noGo},null,2));
