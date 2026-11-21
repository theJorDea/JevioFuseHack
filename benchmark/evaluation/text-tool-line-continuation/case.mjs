export default {
  id: 'text-tool-line-continuation',
  task: 'Recover a text-protocol tool call when a model wraps a JSON argument across physical lines. Preserve argument data and keep well-formed messages working.',
  files: {
    base: [['src/agent.ts', 'base-parser.ts.fixture', '82c4f3c5ba19e9dce72a1c2e2176e737a50ccdea1d73016d33f95ee411b8d6d7']],
    gold: [['src/agent.ts', 'gold-parser.ts.fixture', 'f6c9a8ea65517b1338f6206f62bd52dbdcffdda9827eeba15c8952242ce0378f']],
  },
  probeSha256: '9488f5dba9b2596e7386904c8b4166fed73fea9110057857bc803288b2860600',
};
